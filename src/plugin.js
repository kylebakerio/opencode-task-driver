// opencode-task-driver: the opencode adapter. Wires src/core.js into opencode's plugin hooks.
// See README.md for the design. Tested against opencode 1.18.34.
//
// Hooks used:
//   tool                                   file_tasks, add_task, task_note, finish_task, give_up_task, list_tasks
//                                          (tasks mode)
//   event                                  session.status / session.idle (follow-ups), session.error and assistant
//                                          errors (no follow-up after a failure or an abort), session.created
//                                          (sub-agent sessions are left alone), session.compacted, todo.updated
//   chat.message                           a follow-up arrived (delivered) or the user said something else
//   experimental.chat.messages.transform   marks "the next system prompt is a main-agent request"
//   experimental.chat.system.transform     the planning instructions / the task block
//   experimental.session.compacting        the task list goes into the summarizer's prompt
//   dispose                                last state write
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "./core.js";

const TITLE_PROMPT = "You are a title generator";   // opencode's title agent; its requests get nothing from us

function resolveMode(options) {
  const raw = String(process.env.OPENCODE_TASK_DRIVER || (options && options.mode) || "tasks").trim().toLowerCase();
  if (["off", "0", "false", "no", "none"].includes(raw)) return "off";
  return raw === "tasks" || raw === "enforce" ? raw : { invalid: raw };
}

// "prompt": the plugin sends follow-ups itself (TUI, `opencode serve`, `opencode run --attach` servers).
// "file":   it only records them in the state file (`pending`) for an outside driver to send, e.g. with
//           `opencode run --session <id> "<text>"`. `opencode run` exits a few milliseconds after the session first
//           goes idle, so a prompt sent from inside it is never answered and stays in the session unanswered.
// "auto":   "file" inside `opencode run`, else "prompt".
const SUBCOMMANDS = new Set(["run", "serve", "web", "acp", "attach", "tui", "mini", "export", "import", "debug", "mcp", "github", "pr", "session", "stats"]);
function resolveDelivery(options) {
  const raw = String((options && options.delivery) || "auto").trim().toLowerCase();
  if (raw === "prompt" || raw === "file") return raw;
  const sub = process.argv.slice(2).find((a) => SUBCOMMANDS.has(a));   // the first subcommand word, past global options
  return sub === "run" ? "file" : "prompt";
}

function defaultDir() {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "opencode", "task-driver");
}

export const TaskDriver = async (input, options = {}) => {
  options = options || {};
  const dir = String(options.dir || defaultDir());
  const eventsFile = path.join(dir, ".events.jsonl");
  const log = (o) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(eventsFile, JSON.stringify({ t: Date.now(), ...o }) + "\n");
    } catch {}
  };
  const mode = resolveMode(options);
  if (mode === "off") { log({ event: "loaded", mode: "off", version: core.VERSION }); return {}; }
  if (typeof mode === "object") { log({ event: "error", error: `unknown mode ${JSON.stringify(mode.invalid)}; expected tasks, enforce or off` }); return {}; }
  const delivery = resolveDelivery(options);
  const opts = {
    maxNudgesPerTask: Number.isInteger(options.maxNudgesPerTask) ? options.maxNudgesPerTask : core.DEFAULTS.maxNudgesPerTask,
    maxPrompts: Number.isInteger(options.maxPrompts) ? options.maxPrompts : core.DEFAULTS.maxPrompts,
    finalPass: options.finalPass === undefined ? core.DEFAULTS.finalPass : Boolean(options.finalPass),
  };
  const client = input && input.client;
  log({ event: "loaded", mode, delivery, version: core.VERSION, ...opts });

  // ---- per-session records ----
  const recs = new Map();          // session id -> {state, busy, child, lastErr, cycleErr, agent, model}
  const mainStep = new Set();      // sessions whose next system prompt belongs to a main-agent request
  const compactingNow = new Set(); // sessions in the middle of a compaction
  const rec = (sid) => {
    let r = recs.get(sid);
    if (!r) { r = { state: undefined, busy: false, child: false, lastErr: null, cycleErr: null, agent: undefined, model: undefined }; recs.set(sid, r); }
    return r;
  };
  const fileOf = (sid) => path.join(dir, String(sid).replace(/[^A-Za-z0-9_-]/g, "_") + ".json");
  function load(sid) {
    try {
      const s = JSON.parse(fs.readFileSync(fileOf(sid), "utf8"));
      if (s && s.v === 1 && Array.isArray(s.tasks)) { s.mode = mode; return s; }
    } catch {}
    return null;
  }
  // the state if this session has one (in memory or on disk), else null
  function peek(sid) {
    const r = rec(sid);
    if (r.state === undefined) r.state = load(sid);
    return r.state;
  }
  function stateFor(sid) {
    const r = rec(sid);
    if (!peek(sid)) r.state = core.newState(sid, mode);
    return r.state;
  }
  // Synchronous on purpose: `opencode run` disposes the instance a few ms after idle, before any await returns.
  function save(sid) {
    const s = rec(sid).state;
    if (!s) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const f = fileOf(sid), tmp = f + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
      fs.renameSync(tmp, f);
    } catch (e) { log({ event: "error", session: sid, error: "save: " + String(e && e.message || e) }); }
  }
  const guard = (where, fn) => { try { return fn(); } catch (e) { log({ event: "error", where, error: String(e && e.stack || e).slice(0, 800) }); } };

  // ---- follow-ups ----
  async function send(sid, text) {
    const r = rec(sid);
    try {
      const body = { parts: [{ type: "text", text }] };
      if (r.agent) body.agent = r.agent;
      if (r.model) body.model = r.model;
      const res = await client.session.promptAsync({ path: { id: sid }, body });
      if (res && res.error) log({ event: "send-error", session: sid, error: JSON.stringify(res.error).slice(0, 500) });
      else log({ event: "sent", session: sid });
    } catch (e) { log({ event: "send-error", session: sid, error: String(e && e.message || e).slice(0, 500) }); }
  }

  function onIdle(sid, via) {
    if (!sid) return;
    const r = rec(sid);
    if (!r.busy) return;                  // the second idle event of the same cycle (session.status + session.idle)
    r.busy = false;
    if (r.child) return;                  // sub-agent sessions: never driven
    if (r.lastErr || r.cycleErr) {        // provider error, abort, ...: never turn a failure into another turn
      log({ event: "idle-skipped", session: sid, reason: r.lastErr || r.cycleErr });
      return;
    }
    const s = peek(sid);
    if (!s) return;                       // nothing filed (tasks) / no todo list seen (enforce): inert
    if (s.pending) { log({ event: "pending-dropped", session: sid, kind: s.pending.kind }); s.pending = null; }
    const before = s.stopped;
    const act = core.decide(s, opts);
    if (!act) {
      if (s.stopped && s.stopped !== before) log({ event: "stopped", session: sid, reason: s.stopped });
      save(sid);
      return;
    }
    s.pending = { id: s.prompts, kind: act.kind, task: act.task ?? null, text: act.text, at: Date.now() };
    save(sid);                            // before any await: see save()
    log({ event: "followup", session: sid, kind: act.kind, task: act.task ?? null, from: act.from ?? null, n: act.n ?? null, prompts: s.prompts, delivery, via });
    if (delivery === "prompt" && client) send(sid, act.text);
  }

  // ---- hooks ----
  const hooks = {
    event: async (arg) => guard("event", () => {
      const event = arg && arg.event;
      const p = (event && event.properties) || {};
      switch (event && event.type) {
        case "session.created":
        case "session.updated": {
          const info = p.info;
          if (info && info.id && info.parentID) rec(info.id).child = true;
          break;
        }
        case "session.status": {
          const st = p.status && p.status.type;
          if (!p.sessionID) break;
          if (st === "busy" || st === "retry") rec(p.sessionID).busy = true;
          else if (st === "idle") onIdle(p.sessionID, "session.status");
          break;
        }
        case "session.idle":
          onIdle(p.sessionID, "session.idle");
          break;
        case "session.error":
          if (p.sessionID) rec(p.sessionID).cycleErr = (p.error && p.error.name) || "error";
          break;
        case "message.updated": {
          const info = p.info;
          if (!info || info.role !== "assistant" || !info.sessionID) break;
          const r = rec(info.sessionID);
          if (info.error) r.lastErr = info.error.name || "error";
          else if (info.time && info.time.completed) { r.lastErr = null; r.cycleErr = null; }
          break;
        }
        case "session.compacted": {
          if (!p.sessionID) break;
          compactingNow.delete(p.sessionID);
          const s = peek(p.sessionID);
          if (s && s.tasks.length) { s.compactions += 1; save(p.sessionID); log({ event: "compacted", session: p.sessionID, n: s.compactions }); }
          break;
        }
        case "todo.updated": {
          if (mode !== "enforce" || !p.sessionID || rec(p.sessionID).child) break;
          const s = stateFor(p.sessionID);
          s.todos = (Array.isArray(p.todos) ? p.todos : []).map((t) => ({ id: t.id, content: t.content, status: t.status }));
          save(p.sessionID);
          break;
        }
      }
    }),

    "chat.message": async (inp, out) => guard("chat.message", () => {
      const sid = inp && inp.sessionID;
      if (!sid) return;
      const r = rec(sid);
      if (inp.agent) r.agent = inp.agent;
      if (inp.model) r.model = inp.model;
      r.lastErr = null; r.cycleErr = null;
      const s = peek(sid);
      if (!s || !s.pending) return;
      const text = ((out && out.parts) || []).filter((x) => x && x.type === "text" && !x.synthetic).map((x) => x.text).join("\n");
      const ev = core.seeUserMessage(s, text);
      save(sid);
      if (ev) log({ session: sid, ...ev });
    }),

    "experimental.chat.messages.transform": async (_inp, out) => guard("messages.transform", () => {
      const msgs = (out && out.messages) || [];
      const last = msgs[msgs.length - 1];
      const sid = last && last.info && last.info.sessionID;
      if (!sid) return;
      if (compactingNow.has(sid)) { compactingNow.delete(sid); return; }   // the summarizer's request
      mainStep.add(sid);
    }),

    "experimental.chat.system.transform": async (inp, out) => guard("system.transform", () => {
      const sid = inp && inp.sessionID;
      if (!sid || !core.drivesTasks(mode) || !out || !Array.isArray(out.system)) return;
      if (typeof out.system[0] === "string" && out.system[0].startsWith(TITLE_PROMPT)) return;
      if (!mainStep.has(sid)) return;
      mainStep.delete(sid);
      if (rec(sid).child) return;
      const s = peek(sid) || core.newState(sid, mode);   // no tasks yet: the planning block (nothing saved)
      const key = s.view && s.view.key;
      const block = core.systemBlock(s);
      if (!block) return;
      out.system.push(block);
      if (s.tasks.length && s.view.key !== key) {
        save(sid);
        log({ event: "shown", session: sid, key: s.view.key, chars: block.length });
      }
    }),

    "experimental.session.compacting": async (inp, out) => guard("compacting", () => {
      const sid = inp && inp.sessionID;
      if (!sid) return;
      compactingNow.add(sid);
      if (!core.drivesTasks(mode)) return;
      const s = peek(sid);
      const ctx = s && core.compactionContext(s);
      if (ctx && out && Array.isArray(out.context)) { out.context.push(ctx); log({ event: "compaction-context", session: sid, tasks: s.tasks.length }); }
    }),

    dispose: async () => guard("dispose", () => {
      for (const [sid, r] of recs) if (r.state) save(sid);
      log({ event: "disposed" });
    }),
  };

  if (core.drivesTasks(mode)) hooks.tool = tools({ stateFor, save, log, opts });
  return hooks;
};

// Tool argument schemas are plain JSON Schema: opencode 1.18 accepts them for plugin tools (every listed top-level
// property is required and nothing is validated, so core.js validates). No zod import keeps this a single
// dependency-free file. finish_task's summary may be empty (listed, so opencode shows it as required; core.js accepts
// it empty or missing).
function tools({ stateFor, save, log, opts }) {
  const run = (ctx, fn) => {
    const sid = ctx && ctx.sessionID;
    if (!sid) return "Error: no session";
    const s = stateFor(sid);
    let r;
    try { r = fn(s); } catch (e) { log({ event: "error", session: sid, error: String(e && e.stack || e).slice(0, 800) }); return "Error: " + String(e && e.message || e); }
    save(sid);
    if (r.event) log({ session: sid, ...r.event });
    return r.output;
  };
  const str = (description) => ({ type: "string", description });
  const id = { type: "integer", description: "The task's number in the task list." };
  const item = {
    type: "object",
    properties: {
      title: str("A short name for the problem."),
      details: str("Everything from the request that matters for this problem, written out in full: symptoms, exact error messages and quoted text, expected behaviour, constraints, where to look."),
    },
    required: ["title", "details"],
  };
  return {
    file_tasks: {
      description: "Split the user's request into separate tasks, one per problem, and keep them in a task list outside the conversation. Call it before starting work when the request contains more than one separate problem. Write each task completely: every detail from the request that matters for it (symptoms, exact error text and quotes, expected behaviour, constraints, where to look), so it can be done from its own text alone. Returns the first task.",
      args: {
        tasks: {
          type: "array",
          description: "One entry per separate problem, in the order to work on them.",
          items: item,
        },
      },
      execute: async (args, ctx) => run(ctx, (s) => core.fileTasks(s, args && args.tasks)),
    },
    add_task: {
      description: "Add one more task to the task list, for a separate problem found while working. Write it as completely as file_tasks asks.",
      args: {
        title: str("A short name for the problem."),
        details: str("Everything that matters for this problem, written out in full."),
      },
      execute: async (args, ctx) => run(ctx, (s) => core.addTask(s, args)),
    },
    task_note: {
      description: "Record a finding or a progress note for a task: what you found, what you changed, what is left. Notes are kept with the task list outside the conversation, so they are still there if the conversation is summarized.",
      args: { id, text: str("The note.") },
      execute: async (args, ctx) => run(ctx, (s) => core.taskNote(s, args && args.id, args && args.text)),
    },
    finish_task: {
      description: "Mark a task done. Returns the next task.",
      args: { id, summary: str("Optional: a short note of what you changed. May be left empty.") },
      execute: async (args, ctx) => run(ctx, (s) => core.finishTask(s, args && args.id, args && args.summary, opts)),
    },
    give_up_task: {
      description: "Mark a task as one that cannot be done, with the reason. Returns the next task.",
      args: { id, reason: str("Why it cannot be done.") },
      execute: async (args, ctx) => run(ctx, (s) => core.giveUpTask(s, args && args.id, args && args.reason, opts)),
    },
    list_tasks: {
      description: "Show the task list with each task's status, and the current task in full.",
      args: {},
      execute: async (_args, ctx) => run(ctx, (s) => core.listTasks(s)),
    },
  };
}
