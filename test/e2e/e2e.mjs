#!/usr/bin/env node
// End-to-end test against the real opencode binary and a scripted mock model. No GPU, no network: the whole thing
// re-runs itself inside `bwrap --unshare-net` (Linux; pass --no-sandbox to skip, at your own risk), and opencode
// gets its own XDG config/data/state/cache directories, so your opencode setup and sessions are not touched.
//
//   node test/e2e/e2e.mjs [focus|focus-serve|focus-edge|serve|run|probe|enforce|enforce-serve|all] [--out DIR] [--no-sandbox]
//                         [--strict-system]
//
//   The mock model always runs the focus modes STRICT: like Qwen3.8 Flash-Next's chat template on llama.cpp it rejects
//   (HTTP 500) a request whose system message is not the first message, and the focus checks require zero rejections.
//   --strict-system runs every mode that way (0.2.0's `tasks` mode sends its block as a second system message).
//
//   focus, focus-serve: mode "focus" (0.3.0's default) driven like run / serve: each task after the first is worked in a
//          fresh conversation. Checks what every request showed the model (the task context, and only the current
//          task's messages after each boundary), what the summarizer was given for a compaction inside task 2 (only
//          task 2's conversation, not opencode's previous summary from task 1), the handoffs, the git file list, the
//          final pass, and that the stored session still holds everything.
//
//   serve: mode "tasks", `opencode serve` + HTTP, plugin delivery "prompt" (the plugin sends its follow-ups itself)
//   run:   `opencode run` turns, plugin delivery "auto" (= "file" inside `opencode run`); this script is the outside
//          driver: after each turn it reads the pending follow-up from the state file and runs
//          `opencode run --session <id> "<text>"`.
//   enforce, enforce-serve: mode "enforce" (todo-list follow-ups only) driven like run / serve: no task tools or instructions;
//          the model's own todowrite list has open items when it stops, so the plugin sends one follow-up.
//   probe: ONE `opencode run` with delivery forced to "prompt": does `opencode run` stay alive and answer a follow-up
//          the plugin sends when the session goes idle? (opencode 1.18.34: no -- it exits at the first idle and the
//          follow-up is never answered. This mode checks exactly that, so an opencode upgrade that changes it shows.)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startMock } from "./mock-llm.mjs";
import { REQUEST, FOCUS_HANDOFF_1 } from "./scenario.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const PLUGIN = path.join(ROOT, "dist/opencode-task-driver.js");
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const which = (bin) => spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).stdout.trim();

if (!flag("--inside") && !flag("--no-sandbox")) {
  if (!which("bwrap")) { console.error("bwrap not found: install bubblewrap, or pass --no-sandbox (opencode may then try the network)"); process.exit(2); }
  const r = spawnSync("bwrap", ["--dev-bind", "/", "/", "--unshare-net", "--die-with-parent", process.execPath, fileURLToPath(import.meta.url), ...argv, "--inside"], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const ALL = ["focus", "focus-serve", "focus-edge", "serve", "run", "probe", "enforce", "enforce-serve"];
const MODES = (() => { const m = argv.find((a) => [...ALL, "all"].includes(a)) || "all"; return m === "all" ? ALL : [m]; })();
const isEnforce = (mode) => mode.startsWith("enforce");
const isFocus = (mode) => mode.startsWith("focus");
const pluginMode = (mode) => (isEnforce(mode) ? "enforce" : isFocus(mode) ? "focus" : "tasks");
const mockScenario = (mode) => (mode === "focus-edge" ? "focus-edge" : pluginMode(mode));
const viaRun = (mode) => mode === "run" || mode === "enforce" || mode === "focus" || mode === "focus-edge";     // the outside driver re-runs `opencode run`
const OUT = path.resolve(opt("--out", fs.mkdtempSync(path.join(os.tmpdir(), "otd-e2e-"))));
const OPENCODE = which("opencode") || path.join(os.homedir(), ".opencode/bin/opencode");
const MODEL = { providerID: "mock", modelID: "mock-20k" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup(mode, mockPort) {
  const dir = path.join(OUT, mode);
  fs.rmSync(dir, { recursive: true, force: true });
  const ws = path.join(dir, "ws"), xdg = path.join(dir, "xdg"), stateDir = path.join(dir, "task-driver");
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "config.txt"), "limit = 5\n");
  fs.writeFileSync(path.join(ws, "page.txt"), "");
  spawnSync("sh", ["-c", "git init -q && git add -A && git -c user.email=e2e@example.com -c user.name=e2e commit -qm base"], { cwd: ws });
  for (const d of ["config/opencode", "data", "state", "cache"]) fs.mkdirSync(path.join(xdg, d), { recursive: true });
  const realCache = path.join(os.homedir(), ".cache/opencode");          // models.json + rg, so nothing is fetched
  if (fs.existsSync(realCache)) fs.cpSync(realCache, path.join(xdg, "cache/opencode"), { recursive: true });
  // opencode installs @opencode-ai/plugin into every config dir and, when the config names an external plugin, waits
  // for that install before loading it: with no network that is ~70 s per start. An existing install (package.json +
  // node_modules, as in ~/.config/opencode) satisfies it at once.
  const realCfg = path.join(os.homedir(), ".config/opencode");
  for (const n of ["package.json", "bun.lock", "package-lock.json"]) if (fs.existsSync(path.join(realCfg, n))) fs.copyFileSync(path.join(realCfg, n), path.join(xdg, "config/opencode", n));
  if (fs.existsSync(path.join(realCfg, "node_modules"))) fs.symlinkSync(path.join(realCfg, "node_modules"), path.join(xdg, "config/opencode/node_modules"));
  const cfg = {
    provider: { mock: { npm: "@ai-sdk/openai-compatible", name: "Mock", options: { baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKey: "none" },
      models: { "mock-20k": { name: "mock-20k", limit: { context: 20000, input: 20000, output: 20000 } } } } },
    model: "mock/mock-20k",
    compaction: { reserved: 16384 },                   // usable window 20000 - 16384: a 9000-token step overflows
    permission: { read: "allow", edit: "allow", bash: "allow" },
    plugin: [["file://" + PLUGIN, { dir: stateDir, mode: pluginMode(mode), delivery: viaRun(mode) ? "auto" : "prompt" }]],
  };
  fs.writeFileSync(path.join(xdg, "config/opencode/opencode.json"), JSON.stringify(cfg, null, 1));
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(xdg, "config"), XDG_DATA_HOME: path.join(xdg, "data"), XDG_STATE_HOME: path.join(xdg, "state"),
    XDG_CACHE_HOME: path.join(xdg, "cache"), OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_SHARE: "1" };
  for (const k of ["OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_TASK_DRIVER", "OPENCODE_PURE"]) delete env[k];
  return { mode, dir, ws, stateDir, env };
}

// ---------- serve: the plugin sends its own follow-ups ----------
async function runServe(ctx, mock) {
  const port = 4096 + ALL.indexOf(ctx.mode);
  const logf = fs.openSync(path.join(ctx.dir, "opencode-serve.log"), "w");
  const srv = spawn(OPENCODE, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], { cwd: ctx.ws, env: ctx.env, stdio: ["ignore", logf, logf] });
  const base = `http://127.0.0.1:${port}`;
  // every request has a deadline: a connection made while the server is still starting can be accepted and never
  // answered, and fetch would then wait for its 300 s header timeout
  const api = async (method, p, body, ms = 15000) => {
    const ac = new AbortController(); const to = setTimeout(() => ac.abort(), ms);
    try {
      const r = await fetch(base + p + (p.includes("?") ? "&" : "?") + "directory=" + encodeURIComponent(ctx.ws), { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: ac.signal });
      const t = await r.text(); return t ? JSON.parse(t) : null;
    } finally { clearTimeout(to); }
  };
  try {
    for (let i = 0; ; i++) { try { await api("GET", "/session", undefined, 3000); break; } catch { if (i > 100) throw new Error("opencode serve did not start"); await sleep(200); } }
    const s = await api("POST", "/session", {});
    await api("POST", `/session/${s.id}/prompt_async`, { model: MODEL, parts: [{ type: "text", text: REQUEST }] });
    let lastN = -1, stableSince = Date.now(); const t0 = Date.now();
    for (;;) {                                         // settled: idle, and the mock has seen nothing new for 5 s
      await sleep(500);
      const st = await api("GET", "/session/status");
      const busy = st && st[s.id] && st[s.id].type !== "idle";
      if (mock.log.length !== lastN || busy) { lastN = mock.log.length; stableSince = Date.now(); }
      if (Date.now() - stableSince > 5000) break;
      if (Date.now() - t0 > 180000) throw new Error("timed out waiting for the session to settle");
      if (mock.log.length > 60) throw new Error("more than 60 model requests: the session is looping");
    }
    const messages = await api("GET", `/session/${s.id}/message`);
    return { session: s.id, messages, turns: null };
  } finally { srv.kill("SIGTERM"); await sleep(500); }
}

// ---------- run: opencode exits at the first idle; this loop is the outside driver ----------
// Asynchronous on purpose: the mock model lives in this process, so a blocking spawnSync would deadlock it.
function ocRun(ctx, text, session) {
  const a = ["run", "--format", "json", "--dir", ctx.ws, "-m", `${MODEL.providerID}/${MODEL.modelID}`];
  if (session) a.push("--session", session);
  a.push(text);
  return new Promise((resolve) => {
    const p = spawn(OPENCODE, a, { cwd: ctx.ws, env: ctx.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => p.kill("SIGKILL"), 180000);
    p.on("close", (code) => {
      clearTimeout(timer);
      const lines = stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      resolve({ code, lines, sid: (lines.find((l) => l.sessionID) || {}).sessionID, stderr });
    });
  });
}

async function runRun(ctx, mock) {
  const turns = [];
  let t = await ocRun(ctx, REQUEST);
  turns.push({ prompt: "(the request)", code: t.code, events: t.lines.length });
  const sid = t.sid;
  if (!sid) throw new Error("no session id from opencode run: " + (t.stderr || "").slice(-500));
  for (let i = 0; i < 20; i++) {
    if (mock.log.length > 60) throw new Error("more than 60 model requests: the session is looping");
    const f = path.join(ctx.stateDir, sid + ".json");
    const st = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
    if (!st || !st.pending) break;
    t = await ocRun(ctx, st.pending.text, sid);
    turns.push({ prompt: `${st.pending.kind}${st.pending.task ? " (task " + st.pending.task + ")" : ""}`, code: t.code, events: t.lines.length });
  }
  fs.writeFileSync(path.join(ctx.dir, "turns.json"), JSON.stringify(turns, null, 1));
  const ex = spawnSync(OPENCODE, ["export", sid], { cwd: ctx.ws, env: ctx.env, encoding: "utf8", timeout: 120000, maxBuffer: 64 << 20 });
  const body = ex.stdout.slice(ex.stdout.indexOf("{"));
  return { session: sid, messages: JSON.parse(body).messages, turns };
}

// ---------- probe: delivery "prompt" inside a single `opencode run` ----------
async function runProbe(ctx, mock) {
  const t = await ocRun(ctx, REQUEST);
  if (!t.sid) throw new Error("no session id from opencode run: " + (t.stderr || "").slice(-500));
  const atExit = mock.log.length;
  await sleep(5000);                                   // anything still running somewhere would reach the mock now
  const ex = spawnSync(OPENCODE, ["export", t.sid], { cwd: ctx.ws, env: ctx.env, encoding: "utf8", timeout: 120000, maxBuffer: 64 << 20 });
  const messages = JSON.parse(ex.stdout.slice(ex.stdout.indexOf("{"))).messages;
  return { session: t.sid, messages, turns: [{ prompt: "(the request)", code: t.code }], atExit, after: mock.log.length };
}

function probeChecks(res, mock, ctx) {
  const ev = fs.readFileSync(path.join(ctx.stateDir, ".events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const fu = ev.find((e) => e.event === "followup");
  const sent = ev.find((e) => e.event === "sent" || e.event === "send-error");
  const answered = mock.log.some((r) => r.kind === "agent" && r.last_role === "user" && /Task 2 of 3 .* is still open/.test(r.last_text));
  const last = res.messages[res.messages.length - 1];
  const lastText = last.parts.filter((p) => p.type === "text").map((p) => p.text).join("");
  return [
    ["the plugin decided a follow-up inside `opencode run` and sent it (delivery prompt)", !!fu && fu.delivery === "prompt" && !!sent, JSON.stringify({ followup: fu, sent })],
    ["opencode run exited 0 after the first idle", res.turns[0].code === 0, String(res.turns[0].code)],
    ["the model never saw the follow-up (no request after the run ended)", !answered && res.after === res.atExit, `answered=${answered}, mock requests at exit ${res.atExit}, 5 s later ${res.after}`],
    ["the session's last message is the unanswered follow-up, or nothing was stored", (last.info.role === "user" && /is still open/.test(lastText)) || (last.info.role === "assistant" && last.info.finish === "stop"), `${last.info.role}/${last.info.finish || ""}: ${lastText.slice(0, 60)}`],
  ];
}

function enforceChecks(mode, res, mock, ctx) {
  const agent = mock.log.filter((r) => r.kind === "agent");
  const replies = agent.map((r) => r.reply.tool || "text");
  const st = readState(ctx, res.session);
  const lastMsg = res.messages[res.messages.length - 1];
  const unwrap = (t) => (t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/\\"/g, '"') : t);
  const userTexts = res.messages.filter((m) => m.info.role === "user")
    .map((m) => unwrap(m.parts.filter((p) => p.type === "text" && !p.synthetic).map((p) => p.text).join("").trim())).filter(Boolean);
  const want = ["todowrite", "bash", "todowrite", "text", "bash", "todowrite", "text"];
  const c = [
    ["model calls in order", JSON.stringify(replies) === JSON.stringify(want), replies.join(", ")],
    ["no task tools, no planning or task block, todowrite offered", agent.every((r) => r.task_tools === false && r.current === null && r.todowrite_tool === true), JSON.stringify(agent.map((r) => [r.task_tools, r.current, r.todowrite_tool]))],
    ["user turns: request + one todo follow-up naming the two open items", userTexts.length === 2 && userTexts[1] === "Your todo list still has open items:\n- [in_progress] Make cache entries expire\n- [pending] Add the home page title\n\nContinue working on them. If an item is already done or no longer needed, update the todo list to say so.", JSON.stringify(userTexts.map((t) => t.slice(0, 120)))],
    ["state: todos mirrored (all completed), 1 follow-up, delivered, nothing pending", JSON.stringify(st.todos.map((t) => t.status)) === '["completed","completed","completed"]' && st.prompts === 1 && st.delivered === 1 && st.pending === null && st.tasks.length === 0, JSON.stringify({ todos: st.todos.map((t) => t.status), prompts: st.prompts, delivered: st.delivered, pending: st.pending })],
    ["session ends on an assistant answer", lastMsg.info.role === "assistant" && lastMsg.info.finish === "stop", `${lastMsg.info.role}/${lastMsg.info.finish}`],
  ];
  if (mode === "enforce") c.push(["run turns: request, todo", JSON.stringify(res.turns.map((t) => t.prompt)) === JSON.stringify(["(the request)", "todo"]), res.turns.map((t) => t.prompt).join(", ")]);
  return c;
}

// ---------- transcript + checks ----------
// the plugin's state file for the session; a stand-in when the plugin never filed or saw anything (the checks then fail)
function readState(ctx, sid) {
  const f = path.join(ctx.stateDir, String(sid) + ".json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : { missing: true, tasks: [], todos: [], boundary: null, files: null };
}
function render(messages) {
  const out = [];
  messages.forEach((m, i) => {
    const info = m.info;
    const tag = info.role === "assistant" && info.summary ? "assistant (summary)" : info.role;
    out.push(`### [${i + 1}] ${tag}${info.finish ? ` (finish: ${info.finish})` : ""}`);
    for (const p of m.parts) {
      if (p.type === "text" && p.text) out.push((p.synthetic ? "(added by opencode) " : "") + p.text.trim());
      else if (p.type === "compaction") out.push("(compaction requested)");
      else if (p.type === "tool") {
        const st = p.state || {};
        out.push(`> tool ${p.tool} ${JSON.stringify(st.input || {}).slice(0, 400)}`);
        const o = String(st.output || st.error || "").trim();
        if (o) out.push(o.split("\n").map((l) => "  | " + l).join("\n"));
      }
    }
    out.push("");
  });
  return out.join("\n");
}

function checks(mode, res, mock, ctx) {
  const agent = mock.log.filter((r) => r.kind === "agent");
  const replies = agent.map((r) => r.reply.tool ? r.reply.tool + (r.reply.args && r.reply.args.id ? `(${r.reply.args.id})` : "") : "text");
  const comps = mock.log.filter((r) => r.kind === "compaction");
  let changes = 0; for (let i = 1; i < agent.length; i++) if (agent[i].system_sha !== agent[i - 1].system_sha) changes++;
  const st = readState(ctx, res.session);
  const lastMsg = res.messages[res.messages.length - 1];
  // what was typed (opencode's own compaction request and "Continue if you have next steps" turn are left out); a
  // message sent through `opencode run "<text>"` arrives wrapped in quotes with inner quotes escaped
  const unwrap = (t) => (t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/\\"/g, '"') : t);
  const userTexts = res.messages.filter((m) => m.info.role === "user")
    .map((m) => unwrap(m.parts.filter((p) => p.type === "text" && !p.synthetic).map((p) => p.text).join("").trim())).filter(Boolean);
  const gs = spawnSync("git", ["status", "--porcelain", "--ignored"], { cwd: ctx.ws, encoding: "utf8" }).stdout.split("\n").filter(Boolean).sort();
  const want = ["file_tasks", "bash", "task_note(1)", "finish_task(1)", "bash", "text", "text", "text", "bash", "finish_task(3)", "bash", "text"];
  const c = [
    ["model calls in order", JSON.stringify(replies) === JSON.stringify(want), replies.join(", ")],
    ["one compaction, its prompt carries the task list", comps.length === 1 && comps[0].compaction_has_tasklist === true, `${comps.length} compaction(s), task list: ${comps.map((x) => x.compaction_has_tasklist)}`],
    ["system prompt changed only at the 5 transitions (planning>1, compaction, 1>2, 2>3, 3>closed)", changes === 5, `${changes} changes over ${agent.length} agent requests`],
    ["user turns: request + 2 nudges for task 2 + move-on to task 3", userTexts.length === 4 && /^Task 2 of 3 .* is still open/.test(userTexts[1]) && /^Task 2 of 3 .* is still open/.test(userTexts[2]) && /is set aside as unfinished\.\n\nNext: task 3 of 3/.test(userTexts[3]), userTexts.map((t) => t.split("\n")[0].slice(0, 70)).join(" | ")],
    ["state: done / unfinished / done, final pass via tool result, 3 follow-ups all delivered", JSON.stringify(st.tasks.map((t) => t.status)) === '["done","unfinished","done"]' && st.final_pass === "tool" && st.prompts === 3 && st.delivered === 3 && st.pending === null, JSON.stringify({ statuses: st.tasks.map((t) => t.status), final_pass: st.final_pass, prompts: st.prompts, delivered: st.delivered, pending: st.pending })],
    ["session ends on an assistant answer (no unanswered user message)", lastMsg.info.role === "assistant" && lastMsg.info.finish === "stop", `${lastMsg.info.role}/${lastMsg.info.finish}`],
    ["workspace holds only the model's edits", JSON.stringify(gs) === JSON.stringify([" M config.txt", " M page.txt", "?? cache.txt"].sort()), gs.join(", ")],
  ];
  if (mode === "run") c.push(["run turns: request, nudge, nudge, next", JSON.stringify(res.turns.map((t) => t.prompt)) === JSON.stringify(["(the request)", "nudge (task 2)", "nudge (task 2)", "next (task 3)"]), res.turns.map((t) => t.prompt).join(", ")]);
  c.push(...textChecks(res, mock, st, userTexts));
  return c;
}

// what the model was shown never asks how a task is checked or verified; the tools take no done_when / evidence
const ASKS_CHECK = /verif|checked|how to tell|done when|done_when|evidence/i;
function textChecks(res, mock, st, userTexts) {
  const agent = mock.log.filter((r) => r.kind === "agent");
  const blocks = agent.map((r) => r.plugin_block).filter(Boolean);
  const args = agent.map((r) => r.task_args).find(Boolean) || {};
  const props = (o) => Object.keys((o && o.properties) || {});
  const fileItem = args.file_tasks && args.file_tasks.properties.tasks.items;
  const results = res.messages.flatMap((m) => m.parts).filter((p) => p.type === "tool" && ["file_tasks", "add_task", "task_note", "finish_task", "give_up_task", "list_tasks"].includes(p.tool))
    .map((p) => String((p.state && (p.state.output || p.state.error)) || ""));
  const comp = mock.log.filter((r) => r.kind === "compaction").map((r) => r.compaction_text || "");
  const shown = [...blocks, ...userTexts.slice(1), ...results, ...comp];
  const bad = shown.filter((t) => ASKS_CHECK.test(t));
  return [
    ["tools as opencode sent them: file_tasks items {title, details}, finish_task {id, summary}, add_task {title, details}",
      JSON.stringify(props(fileItem)) === '["title","details"]' && JSON.stringify(fileItem.required) === '["title","details"]' && JSON.stringify(props(args.finish_task)) === '["id","summary"]' && JSON.stringify(props(args.add_task)) === '["title","details"]',
      JSON.stringify({ file_tasks_item: props(fileItem), finish_task: props(args.finish_task), add_task: props(args.add_task) })],
    ["every agent request carried the plugin's block: planning first, then task blocks", agent.every((r) => r.plugin_block) && blocks[0].startsWith("<task_planning>") && blocks.slice(1).every((b) => b.startsWith("<task_list>")), `${blocks.length} blocks over ${agent.length} agent requests`],
    ["nothing the plugin showed asks how anything was checked (blocks, follow-ups, tool results, compaction prompt)", shown.length > 10 && bad.length === 0, `${shown.length} texts, ${bad.length} matching: ${bad.map((t) => t.slice(0, 120)).join(" | ")}`],
    ["the nudges use the plain wording", userTexts.slice(1, 3).every((t) => t.endsWith("Continue working on this task. When it is done, call finish_task; if it cannot be done, call give_up_task with the reason.")), userTexts.slice(1, 3).map((t) => t.slice(-90)).join(" | ")],
    ["state: no done_when; task 1 closed with its summary, task 3 with none; the final pass asked in the tool result", st.mode === "tasks" && st.tasks.every((t) => !("done_when" in t) && !("evidence" in t)) && (st.tasks[0] || {}).summary === "Set `limit = 10` in config.txt." && (st.tasks[2] || {}).summary === null && results.some((r) => /^Task 3 marked done\.\n\nAll tasks are closed \(2 done, 1 set aside unfinished\)\.\nAs a last step, run the project's full test suite/.test(r)),
      JSON.stringify({ mode: st.mode, summaries: st.tasks.map((t) => t.summary), keys: Object.keys(st.tasks[0] || {}) })],
  ];
}

// focus: the clean slate, request by request
function focusChecks(mode, res, mock, ctx) {
  const agent = mock.log.filter((r) => r.kind === "agent");
  const replies = agent.map((r) => r.reply.tool ? r.reply.tool + (r.reply.args && r.reply.args.id ? `(${r.reply.args.id})` : "") : "text");
  const comps = mock.log.filter((r) => r.kind === "compaction");
  const st = readState(ctx, res.session);
  const lastMsg = res.messages[res.messages.length - 1];
  const want = ["file_tasks", "read", "bash", "task_note(1)", "finish_task(1)", "bash", "text", "text", "text", "bash", "finish_task(3)", "bash", "text"];
  const idx = (pred) => agent.findIndex(pred);
  const first2 = idx((r) => r.current === "2"), first3 = idx((r) => r.current === "3"), firstClosed = idx((r) => r.current === "closed");
  const T1 = /printf 'limit|Root cause: config\.txt/;                     // task 1's conversation (its bash command, its note)
  const REQ = /There are three separate problems in this project/;       // the request's first line
  const shown = (r) => r.view.map((m) => m.text + " " + (m.calls || []).join(" ")).join("\n");
  const after1 = agent.slice(first2);
  const after2 = agent.slice(first3);
  const c2 = comps.find((x) => /covers only the current task \(task 2 of 3/.test(x.compaction_input || ""));
  const c1 = comps.find((x) => x !== c2);
  const blk = agent[first2] && agent[first2].plugin_block || "";
  const gs = spawnSync("git", ["status", "--porcelain"], { cwd: ctx.ws, encoding: "utf8" }).stdout.split("\n").filter(Boolean).sort();
  const stored = JSON.stringify(res.messages);
  let changes = 0; for (let i = 1; i < agent.length; i++) if (agent[i].system_sha !== agent[i - 1].system_sha) changes++;
  const c = [
    ["model calls in order", JSON.stringify(replies) === JSON.stringify(want), replies.join(", ")],
    ["task 1 kept the conversation it started in (the request is its first message until opencode compacts)", agent.slice(1, 4).every((r) => r.view[0].role === "user" && REQ.test(r.view[0].text)), JSON.stringify(agent.slice(1, 4).map((r) => r.view[0].text.slice(0, 60)))],
    ["task 2's first request: one message, the start of task 2 -- nothing from task 1, not even the request",
      agent[first2] && agent[first2].view.length === 1 && agent[first2].view[0].role === "user" && /^We are now on task 2 of 3: Make cache entries expire\./.test(agent[first2].view[0].text),
      JSON.stringify(agent[first2] && agent[first2].view)],
    ["no request after the first boundary shows task 1's conversation or the request as a message", after1.every((r) => !T1.test(shown(r)) && !REQ.test(shown(r))), after1.filter((r) => T1.test(shown(r)) || REQ.test(shown(r))).map((r) => r.i).join(",")],
    ["the task context for task 2: the request first, task 1 done with its handoff, the files, task 2 last",
      /^<task_context>\nWe received the request below\. It is here for reference/.test(blk) && blk.includes("<request>\nThere are three separate problems") &&
      blk.includes("1. [done] Raise the request limit in config.txt\n   Handoff: " + FOCUS_HANDOFF_1 + "\n2. [current] Make cache entries expire") &&
      blk.includes("Files changed so far (from git, compared with the start of the work):\n- modified: config.txt") &&
      blk.indexOf("<request>") < blk.indexOf("The tasks, in order:") && blk.indexOf("The tasks, in order:") < blk.indexOf("The current task is task 2 of 3: Make cache entries expire"),
      blk.slice(0, 1600)],
    ["v3.1: task 2's context maps task 1's files (config.txt read and changed in task 1)", blk.includes("\n\nFiles the earlier tasks looked at (task numbers; * = changed in that task):\n- config.txt: 1*\n\nThe current task is task 2 of 3"), blk.slice(blk.indexOf("Files changed so far"), blk.indexOf("The current task"))],
    ["v3.1: the work rules hold the test-discipline line", blk.includes("If a task cannot be done, call give_up_task with its id, the reason and a handoff.\nWhile working on a task, run only the tests for that task; the full test suite (and any build or lint step) runs once, at the end, after the last task.\nUse task_note"), blk.slice(-600)],
    ["v3.1: the handoff as opencode sent it asks for locations, not test status", /^Where things are and what you changed, focused and terse:/.test((((agent.map((r) => r.task_args).find(Boolean) || {}).finish_task || {}).properties || {}).handoff?.description || ""), JSON.stringify(((agent.map((r) => r.task_args).find(Boolean) || {}).finish_task || {}).properties)],
    ["v3.1: task 1's file map entries are in the state (read via the read tool, changed via git)", JSON.stringify(st.tasks[0] && st.tasks[0].reads) === '["config.txt"]' && JSON.stringify(st.tasks[0] && st.tasks[0].changed) === '["config.txt"]', JSON.stringify(st.tasks.map((t) => [t.reads, t.changed]))],
    ["v3.1: a file read through bash counts too (task 3's `cat page.txt`)", JSON.stringify(st.tasks[2] && st.tasks[2].reads) === '["page.txt"]', JSON.stringify(st.tasks.map((t) => t.reads))],
    ["two compactions: one inside task 1 (opencode's prompt + the task list), one inside task 2", comps.length === 2 && !!c1 && !!c2 && c1.compaction_has_tasklist === true, `${comps.length} compaction(s)`],
    ["the task-2 summarizer saw only task 2: its start and its bash call, not task 1's conversation, the request, or the task-1 summary",
      !!c2 && /We are now on task 2 of 3/.test(c2.compaction_input) && /printf 'ttl = \?/.test(c2.compaction_input) && !T1.test(c2.compaction_input) && !REQ.test(c2.compaction_input) && !/fixed config\.txt \(task 1\)/.test(c2.compaction_input),
      c2 ? c2.compaction_input.slice(0, 1500) : "(none)"],
    ["the task-2 summarizer got the plugin's own prompt (no <prior-summary>, since opencode's previous summary was task 1's)", !!c2 && /\nSummarize the conversation below so that another coding agent can continue the work\./.test(c2.compaction_input) && !/prior-summary/.test(c2.compaction_input) && /The following is the conversation history:\n\n\[User\]: We are now on task 2 of 3/.test(c2.compaction_input), c2 ? c2.compaction_input.slice(0, 200) : ""],
    ["after that compaction task 2's view is its summary and the continue message, still nothing from task 1", agent.slice(first2 + 1, first3).every((r) => /Task 2: started on the cache expiry/.test(shown(r)) && !T1.test(shown(r))), JSON.stringify(agent[first2 + 1] && agent[first2 + 1].view)],
    ["task 3's first request starts with the follow-up that set task 2 aside, and nothing before it",
      agent[first3] && agent[first3].view.length === 1 && /^"?Task 2 of 3 \(Make cache entries expire\) is set aside as unfinished\.\\?n?/.test(agent[first3].view[0].text) && !/Task 2: started/.test(shown(agent[first3])),
      JSON.stringify(agent[first3] && agent[first3].view)],
    ["the final pass starts fresh: one message, the requirements check (v3.1) and then the full test run", agent[firstClosed] && agent[firstClosed].view.length === 1 && /^All tasks are closed \(2 done, 1 set aside unfinished\)\.\nAs a last step, re-read the original request \(it is in the task context\) and check each requirement and example it states against the changes made, especially the conditions that tell cases apart \(for example a case that should still behave as it does now\)\. Fix any gap you find\. Then run the project's full test suite/.test(agent[firstClosed].view[0].text) && /The tasks, all now closed:/.test(agent[firstClosed].plugin_block || ""), JSON.stringify(agent[firstClosed] && agent[firstClosed].view)],
    ["system prompt changed only at transitions (planning>1, compaction with a new note, 1>2, 2>3, 3>closed)", changes === 5, `${changes} changes over ${agent.length} agent requests`],
    ["state: done / unfinished / done, handoffs kept, 3 boundaries, files from git", JSON.stringify(st.tasks.map((t) => t.status)) === '["done","unfinished","done"]' && (st.tasks[0] || {}).handoff === FOCUS_HANDOFF_1 && (st.tasks[2] || {}).handoff === "none" && (st.boundary || {}).n === 3 && JSON.stringify(st.files) === JSON.stringify([{ s: "M", p: "config.txt" }, { s: "M", p: "page.txt" }, { s: "?", p: "cache.txt" }]) && st.request && REQ.test(st.request), JSON.stringify({ statuses: st.tasks.map((t) => t.status), handoffs: st.tasks.map((t) => t.handoff), boundary: st.boundary && st.boundary.n, files: st.files })],
    ["the stored session still holds everything (task 1's bash and note, the request)", T1.test(stored) && REQ.test(stored), ""],
    ["session ends on an assistant answer", lastMsg.info.role === "assistant" && lastMsg.info.finish === "stop", `${lastMsg.info.role}/${lastMsg.info.finish}`],
    ["workspace holds only the model's edits", JSON.stringify(gs) === JSON.stringify([" M config.txt", " M page.txt", "?? cache.txt"].sort()), gs.join(", ")],
  ];
  if (mode === "focus") c.push(["run turns: request, nudge, nudge, next", JSON.stringify(res.turns.map((t) => t.prompt)) === JSON.stringify(["(the request)", "nudge (task 2)", "nudge (task 2)", "next (task 3)"]), res.turns.map((t) => t.prompt).join(", ")]);
  const texts = [...agent.map((r) => r.plugin_block || ""), ...agent.flatMap((r) => r.view.filter((m) => m.role === "user").map((m) => m.text)).filter((t) => !REQ.test(t)), ...comps.map((x) => x.compaction_text || "")];
  const bad = texts.filter((t) => /verif|checked|how to tell|done when|done_when|evidence/i.test(t));
  c.push(["nothing shown asks how anything was checked", bad.length === 0, bad.map((t) => t.slice(0, 120)).join(" | ")]);
  return c;
}

// focus-edge: opencode compacts right at a boundary (the step that closed task 1 reported a nearly full window, so the
// compaction starts before task 2's first request). Its summarizer is shown only task 2's start, and the view of task 2
// leaves that compaction out: task 2 starts as it would have without it.
function focusEdgeChecks(res, mock, ctx) {
  const agent = mock.log.filter((r) => r.kind === "agent");
  const replies = agent.map((r) => r.reply.tool ? r.reply.tool + (r.reply.args && r.reply.args.id ? `(${r.reply.args.id})` : "") : "text");
  const comps = mock.log.filter((r) => r.kind === "compaction");
  const want = ["file_tasks", "read", "bash", "task_note(1)", "finish_task(1)", "bash", "text", "text", "text", "bash", "finish_task(3)", "bash", "text"];
  const first2 = agent.findIndex((r) => r.current === "2");
  const shown = (r) => r.view.map((m) => m.text + " " + (m.calls || []).join(" ")).join("\n");
  const conv = comps[0] && (comps[0].compaction_input.match(/<conversation>\n([\s\S]*?)\n<\/conversation>/) || [])[1];
  const evs = fs.readFileSync(path.join(ctx.stateDir, ".events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const stored = JSON.stringify(res.messages);
  return [
    ["model calls in order", JSON.stringify(replies) === JSON.stringify(want), replies.join(", ")],
    ["one compaction, between finish_task(1) and task 2's first request", comps.length === 1 && comps[0].i > agent[first2 - 1].i && comps[0].i < agent[first2].i, comps.map((x) => x.i).join(",")],
    ["its summarizer was shown only the start of task 2", typeof conv === "string" && /^\[User\]: We are now on task 2 of 3: Make cache entries expire\./.test(conv) && conv.split("\n\n").length === 1, JSON.stringify(conv)],
    ["the plugin noted it as hollow, once", evs.filter((e) => e.event === "hollow-compaction").length === 1, JSON.stringify(evs.filter((e) => e.event === "hollow-compaction"))],
    ["task 2's first request is just its start: no compaction request, summary or 'stop and ask' message", agent[first2].view.length === 1 && /^We are now on task 2 of 3/.test(agent[first2].view[0].text) && !/What did we do so far/.test(agent[first2].view[0].text), JSON.stringify(agent[first2].view)],
    ["no later request in task 2 shows that summary or opencode's continue message", agent.filter((r) => r.current === "2").every((r) => !/Task 2: started on the cache expiry|Continue if you have next steps/.test(shown(r))), ""],
    ["the stored session still holds the compaction and opencode's continue message", /Continue if you have next steps/.test(stored) && /"summary":true/.test(stored), ""],
  ];
}

let failed = 0;
for (const mode of MODES) {
  const mockPort = 18080 + MODES.indexOf(mode);
  const strict = isFocus(mode) || flag("--strict-system");
  const mock = await startMock(mockPort, { scenario: mockScenario(mode), strict });
  const ctx = setup(mode, mockPort);
  const t0 = Date.now();
  let res;
  try { res = mode === "probe" ? await runProbe(ctx, mock) : viaRun(mode) ? await runRun(ctx, mock) : await runServe(ctx, mock); }
  catch (e) { console.error(`[${mode}] ERROR: ${e.stack || e}`); failed++; mock.server.close(); continue; }
  mock.server.close();
  fs.writeFileSync(path.join(ctx.dir, "transcript.md"), `# ${mode} transcript (session ${res.session})\n\n` + render(res.messages));
  fs.writeFileSync(path.join(ctx.dir, "mock-log.json"), JSON.stringify(mock.log, null, 1));
  let c;
  try { c = mode === "probe" ? probeChecks(res, mock, ctx) : isEnforce(mode) ? enforceChecks(mode, res, mock, ctx) : mode === "focus-edge" ? focusEdgeChecks(res, mock, ctx) : isFocus(mode) ? focusChecks(mode, res, mock, ctx) : checks(mode, res, mock, ctx); }
  catch (e) { c = [["the checks could run (the session went far enough to check)", false, String(e && e.message || e).slice(0, 300)]]; }
  const rejected = mock.log.filter((r) => r.kind === "rejected").length;
  if (strict) c.push(["the strict mock rejected no request (one leading system message only)", rejected === 0, `${rejected} rejected`]);
  console.log(`\n== ${mode}: ${((Date.now() - t0) / 1000).toFixed(1)} s, ${mock.log.length} model requests${strict ? `, strict mock: ${rejected} rejected` : ""}, transcript ${path.join(ctx.dir, "transcript.md")}`);
  for (const [name, ok, detail] of c) { console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "\n        got: " + detail}`); if (!ok) failed++; }
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
