// One fixed script of plugin calls, in the order opencode 1.18.34 makes them, recording every string the model can see
// (what is added to the system prompt, each tool's definition and every tool result, the follow-ups, the compaction
// context, the conversation as the model would see it) plus the state files and the event log. test/compat.test.js
// runs it against the frozen 0.2.0 build (test/fixtures/) and the current src + dist: `tasks` and `enforce` must come
// out identical.
//
//   node test/script.mjs <plugin file> <mode> [prompt|file]   -> the record as JSON on stdout
//
// The calls are the same in every mode (tools are skipped when a mode has none), so the record of one mode can be
// compared across builds as it is.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const T = (n) => ({ title: `Problem ${n}`, details: `Details ${n}: the "exact" error ERR-${n}.`, done_when: `check-${n} passes` });

// extra: more plugin options (0.3.1: {fileMap, testRule}). Times (any number from 1e12 to 1e14: Date.now() values) come
// out as "<time>", so two runs of the same build record the same thing.
export async function runScript(pluginFile, mode, delivery = "prompt", extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otd-script-"));
  const sent = [];
  const client = { session: { promptAsync: async (req) => { sent.push(req.body.parts[0].text); return { data: undefined }; } } };
  const saved = process.env.OPENCODE_TASK_DRIVER;
  delete process.env.OPENCODE_TASK_DRIVER;
  const mod = await import(pathToFileURL(path.resolve(pluginFile)).href);
  const hooks = await mod.TaskDriver({ client, directory: "/w" }, { dir, delivery, mode, ...extra });
  const toolDone = async (tool, args, sid = S1) => hooks["tool.execute.after"] && hooks["tool.execute.after"]({ tool, sessionID: sid, callID: "call_" + tool, args }, { title: "", output: "", metadata: {} });
  if (saved !== undefined) process.env.OPENCODE_TASK_DRIVER = saved;
  const rec = [];
  const put = (label, value) => rec.push([label, value]);
  const ev = (type, properties) => ({ event: { type, properties } });
  const S1 = "ses_one", S2 = "ses_two", S3 = "ses_three", CHILD = "ses_child";

  const request = async (sid, base = "You are opencode, an interactive CLI tool.") => {
    if (!hooks["experimental.chat.messages.transform"]) return [base];
    await hooks["experimental.chat.messages.transform"]({}, { messages: [{ info: { sessionID: sid, role: "user" }, parts: [] }] });
    const out = { system: [base] };
    await hooks["experimental.chat.system.transform"]({ sessionID: sid, model: {} }, out);
    return out.system;
  };
  // the conversation as opencode passes it to messages.transform (changed in place), then the system prompt: the view
  // the model gets. Times: 1-3 = long ago, 4e12 = after anything this script does.
  const view = async (label, sid = S1, msgs) => {
    if (!hooks["experimental.chat.messages.transform"]) { put(label, null); return; }
    const list = msgs || [
      { info: { id: "msg_u0", sessionID: sid, role: "user", time: { created: 1 } }, parts: [{ id: "p0", type: "text", text: "fix these problems" }] },
      { info: { id: "msg_1", sessionID: sid, role: "assistant", time: { created: 2 } }, parts: [{ id: "p1", type: "tool", tool: "finish_task", callID: "c1", state: { status: "completed", input: { id: 1 }, output: "Task 1 marked done." } }] },
      { info: { id: "msg_a2", sessionID: sid, role: "assistant", time: { created: 4e12 } }, parts: [{ id: "p2", type: "text", text: "Looking at the next problem." }] },
    ];
    await hooks["experimental.chat.messages.transform"]({}, { messages: list });
    const out = { system: ["You are opencode"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: sid, model: {} }, out);
    put(label, { messages: list, system: out.system });
  };
  const tool = async (name, args, sid = S1) => (hooks.tool && hooks.tool[name] ? hooks.tool[name].execute(args, { sessionID: sid, messageID: "msg_1", agent: "build" }) : "(no such tool)");
  const userMessage = async (text, sid = S1) => hooks["chat.message"] && hooks["chat.message"]({ sessionID: sid, agent: "build", model: { providerID: "p", modelID: "m" } }, { message: {}, parts: [{ type: "text", text }] });
  const stateFile = (sid) => path.join(dir, sid + ".json");
  // one cycle ending normally (or with an error); then the follow-up the plugin decided, sent or recorded, is delivered
  const idle = async (label, sid = S1, { error } = {}) => {
    if (!hooks.event) { put(label, "(no event hook)"); return; }
    const before = sent.length;
    await hooks.event(ev("session.status", { sessionID: sid, status: { type: "busy" } }));
    await hooks.event(ev("message.updated", { info: { role: "assistant", sessionID: sid, time: { created: 1, completed: 2 }, ...(error ? { error: { name: error } } : { finish: "stop" }) } }));
    await hooks.event(ev("session.status", { sessionID: sid, status: { type: "busy" } }));
    await hooks.event(ev("session.status", { sessionID: sid, status: { type: "idle" } }));
    await hooks.event(ev("session.idle", { sessionID: sid }));
    await new Promise((r) => setImmediate(r));
    let text = sent.length > before ? sent[sent.length - 1] : null;
    if (!text && fs.existsSync(stateFile(sid))) { const p = JSON.parse(fs.readFileSync(stateFile(sid), "utf8")).pending; text = p ? p.text : null; }
    put(label, text);
    if (text) await userMessage(text, sid);
  };

  put("hooks", Object.keys(hooks).sort());
  put("tools", hooks.tool ? Object.fromEntries(Object.keys(hooks.tool).sort().map((k) => [k, { description: hooks.tool[k].description, args: hooks.tool[k].args }])) : null);
  put("request: nothing filed", await request(S1));
  if (hooks["experimental.chat.system.transform"]) {
    const bare = { system: ["You are opencode"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: S1, model: {} }, bare);
    put("system without a main-step mark", bare.system);
  }
  put("title request", await request(S1, "You are a title generator. You output ONLY a thread title."));
  await userMessage("fix these problems");
  await idle("idle: nothing filed");
  for (const [label, tasks] of [["empty", []], ["not json", "nope"], ["no details", [{ title: "a" }]], ["no title", [{ details: "x" }]], ["bad entry", [JSON.stringify(T(1)), 5]], ["too many", Array.from({ length: 41 }, (_, i) => T(i))]]) {
    put(`file_tasks error: ${label}`, await tool("file_tasks", { tasks }));
  }
  put("task_note before filing", await tool("task_note", { id: 1, text: "x" }));
  put("finish_task before filing", await tool("finish_task", { id: 1, evidence: "x" }));
  put("list_tasks before filing", await tool("list_tasks", {}));
  put("file_tasks", await tool("file_tasks", { tasks: JSON.stringify([T(1), T(2), T(3)]) }));
  put("file_tasks again", await tool("file_tasks", { tasks: [T(9)] }));
  put("request: task 1", await request(S1));
  put("task_note", await tool("task_note", { id: 1, text: "cause: off-by-one in parse()" }));
  await toolDone("read", { filePath: "/w/src/parse.js" });
  await toolDone("edit", { filePath: "/w/src/parse.js", oldString: "a", newString: "b" });
  put("task_note: no such task", await tool("task_note", { id: 7, text: "x" }));
  put("task_note: empty", await tool("task_note", { id: 1, text: " " }));
  put("request: task 1 after a note", await request(S1));
  put("list_tasks", await tool("list_tasks", {}));
  put("finish_task 1: id only", await tool("finish_task", { id: 1 }));
  put("finish_task 1: with evidence", await tool("finish_task", { id: "1", evidence: "check-1 passed" }));
  put("finish_task: no such task", await tool("finish_task", { id: 9, evidence: "x" }));
  put("add_task", await tool("add_task", T(4)));
  put("add_task: no details", await tool("add_task", { title: "x" }));
  put("request: task 2", await request(S1));
  await toolDone("read", { filePath: "/w/src/cache.js" });
  await view("view: task 2");
  if (hooks["experimental.session.compacting"]) {
    const out = { context: [], prompt: undefined };
    await hooks["experimental.session.compacting"]({ sessionID: S1 }, out);
    put("compaction context", out.context);
    put("compaction prompt", out.prompt === undefined ? null : out.prompt);
    await view("view + request: the summarizer's");
    await hooks.event(ev("session.compacted", { sessionID: S1 }));
  }
  put("request: after compaction", await request(S1));
  await hooks.event?.(ev("todo.updated", { sessionID: S1, todos: [{ id: "a", content: "fix A", status: "completed", priority: "high" }, { id: "b", content: "fix B", status: "in_progress", priority: "high" }, { id: "c", content: "fix C", status: "pending", priority: "high" }] }));
  await userMessage("go on");
  await idle("idle 1");
  await idle("idle 2");
  await idle("idle 3");
  put("request: after idles", await request(S1));
  put("give_up_task: no reason", await tool("give_up_task", { id: 3 }));
  put("give_up_task", await tool("give_up_task", { id: 3, reason: "needs a service that is not available" }));
  put("request: task 4", await request(S1));
  await view("view: task 4");
  put("finish_task 4 (last)", await tool("finish_task", { id: 4, evidence: "check-4 ok", summary: "changed the parser" }));
  put("finish_task 4 again", await tool("finish_task", { id: 4, evidence: "x", summary: "x" }));
  await hooks.event?.(ev("todo.updated", { sessionID: S1, todos: [{ id: "a", content: "fix A", status: "completed", priority: "high" }, { id: "b", content: "fix B", status: "completed", priority: "high" }, { id: "c", content: "fix C", status: "completed", priority: "high" }] }));
  await idle("idle 4: all closed");
  put("request: all closed", await request(S1));
  await view("view: all closed");
  put("list_tasks: all closed", await tool("list_tasks", {}));
  if (hooks["experimental.session.compacting"]) {
    const out = { context: [] };
    await hooks["experimental.session.compacting"]({ sessionID: S1 }, out);
    put("compaction context: all closed", out.context);
  }
  // a second session: the model never finishes its one task -> two nudges, then set aside with the final pass as a prompt
  put("S2 file_tasks", await tool("file_tasks", { tasks: [T(1)] }, S2));
  await hooks.event?.(ev("todo.updated", { sessionID: S2, todos: [{ id: "x", content: "only item", status: "pending", priority: "high" }] }));
  for (let i = 1; i <= 4; i++) await idle(`S2 idle ${i}`, S2);
  // a failed cycle is never followed up; a clean one after a new user message is
  put("S3 file_tasks", await tool("file_tasks", { tasks: [T(1), T(2)] }, S3));
  await hooks.event?.(ev("todo.updated", { sessionID: S3, todos: [{ id: "y", content: "item", status: "pending", priority: "high" }] }));
  await idle("S3 idle after an abort", S3, { error: "MessageAbortedError" });
  await userMessage("continue", S3);
  await idle("S3 idle after a new message", S3);
  // a sub-agent session is left alone
  await hooks.event?.(ev("session.created", { info: { id: CHILD, parentID: S1 } }));
  put("child file_tasks", await tool("file_tasks", { tasks: [T(1)] }, CHILD));
  put("child request", await request(CHILD));
  await idle("child idle", CHILD);
  if (hooks.dispose) await hooks.dispose();
  put("sent", sent);
  const states = {};
  for (const n of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
    if (!n.endsWith(".json")) continue;
    const s = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
    if (s.pending) delete s.pending.at;
    states[n] = s;
  }
  put("state files", states);
  const evf = path.join(dir, ".events.jsonl");
  put("events", fs.existsSync(evf) ? fs.readFileSync(evf, "utf8").trim().split("\n").map((l) => { const o = JSON.parse(l); delete o.t; delete o.version; return o; }) : []);
  fs.rmSync(dir, { recursive: true, force: true });
  const times = (v) => (typeof v === "number" && v >= 1e12 && v < 1e14 ? "<time>" : Array.isArray(v) ? v.map(times)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, times(x)])) : v);
  return times(rec);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const [file, mode, delivery] = process.argv.slice(2);
  console.log(JSON.stringify(await runScript(file, mode, delivery || "prompt")));
}
