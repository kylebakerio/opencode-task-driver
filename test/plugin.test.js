// The opencode adapter, driven with a fake client and event sequences in the order opencode 1.18.34 emits them
// (checked with a probe plugin: busy, ..., message.updated(assistant, completed), busy, status idle, session.idle).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const IMPLS = { src: "../src/plugin.js", dist: "../dist/opencode-task-driver.js" };
const SID = "ses_root1";
const T = (n) => ({ title: `Problem ${n}`, details: `Details ${n}: ERR-${n}` });

function fakeClient() {
  const sent = [];
  return { sent, session: { promptAsync: async (req) => { sent.push(req); return { data: undefined, response: { status: 204 } }; } } };
}

async function make(impl, opts = {}, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otd-test-"));
  const client = fakeClient();
  const saved = { ...process.env };
  delete process.env.OPENCODE_TASK_DRIVER;
  Object.assign(process.env, env);
  try {
    const mod = await import(IMPLS[impl]);
    const hooks = await mod.TaskDriver({ client, directory: "/w" }, { dir, delivery: "prompt", mode: "tasks", ...opts });
    return { hooks, client, dir, mod };
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

const ev = (type, properties) => ({ event: { type, properties } });
const ctx = (sid = SID) => ({ sessionID: sid, messageID: "msg_1", agent: "build" });
const events = (dir) => fs.existsSync(path.join(dir, ".events.jsonl"))
  ? fs.readFileSync(path.join(dir, ".events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const stateOf = (dir, sid = SID) => JSON.parse(fs.readFileSync(path.join(dir, sid + ".json"), "utf8"));

// one model request as opencode makes it: messages.transform, then system.transform -> the system array sent
async function request(hooks, sid = SID, base = "You are opencode, an interactive CLI tool.") {
  await hooks["experimental.chat.messages.transform"]({}, { messages: [{ info: { sessionID: sid, role: "user" }, parts: [] }] });
  const out = { system: [base] };
  await hooks["experimental.chat.system.transform"]({ sessionID: sid, model: {} }, out);
  return out.system;
}
// a cycle ending normally: busy ... assistant completed ... busy, idle, session.idle
async function idleCycle(hooks, sid = SID, { error } = {}) {
  await hooks.event(ev("session.status", { sessionID: sid, status: { type: "busy" } }));
  await hooks.event(ev("message.updated", { info: { role: "assistant", sessionID: sid, finish: error ? undefined : "stop", time: { created: 1, completed: 2 }, ...(error ? { error: { name: error } } : {}) } }));
  await hooks.event(ev("session.status", { sessionID: sid, status: { type: "busy" } }));
  await hooks.event(ev("session.status", { sessionID: sid, status: { type: "idle" } }));
  await hooks.event(ev("session.idle", { sessionID: sid }));
  await new Promise((r) => setImmediate(r));
}
async function userMessage(hooks, text, sid = SID) {
  await hooks["chat.message"]({ sessionID: sid, agent: "build", model: { providerID: "p", modelID: "m" } }, { message: {}, parts: [{ type: "text", text }] });
}

for (const impl of Object.keys(IMPLS)) {
  test(`[${impl}] off mode is inert; the env var overrides the option`, async () => {
    let { hooks, dir } = await make(impl, { mode: "off" });
    assert.deepEqual(Object.keys(hooks), []);
    assert.equal(events(dir)[0].mode, "off");
    ({ hooks } = await make(impl, { mode: "tasks" }, { OPENCODE_TASK_DRIVER: "off" }));
    assert.deepEqual(Object.keys(hooks), []);
    ({ hooks } = await make(impl, { mode: "off" }, { OPENCODE_TASK_DRIVER: "enforce" }));
    assert.equal(hooks.tool, undefined);
    assert.ok(hooks.event);
    for (const bad of ["bogus", "todo"]) {
      ({ hooks, dir } = await make(impl, { mode: bad }));
      assert.deepEqual(Object.keys(hooks), []);
      assert.equal(events(dir).at(-1).error, `unknown mode "${bad}"; expected focus, tasks, enforce or off`);
    }
    ({ hooks, dir } = await make(impl, { mode: undefined }));
    assert.equal(events(dir)[0].mode, "focus", "focus is the default since 0.3.0");
    assert.ok(hooks.tool);
  });

  test(`[${impl}] tasks mode: planning block, then a byte-stable task block that changes only at transitions`, async () => {
    const { hooks, dir } = await make(impl);
    assert.deepEqual(Object.keys(hooks.tool).sort(), ["add_task", "file_tasks", "finish_task", "give_up_task", "list_tasks", "task_note"]);
    // every tool's args are plain JSON Schema objects (opencode 1.18's non-zod path)
    for (const t of Object.values(hooks.tool)) for (const v of Object.values(t.args)) assert.equal(typeof v.type, "string");
    let sys = await request(hooks);
    assert.equal(sys.length, 2); assert.match(sys[1], /^<task_planning>/);
    assert.equal(fs.existsSync(path.join(dir, SID + ".json")), false, "nothing stored before anything is filed");
    // no main-step mark (e.g. a forked title request) -> nothing
    const bare = { system: ["You are opencode"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: SID, model: {} }, bare);
    assert.equal(bare.system.length, 1);
    // the title agent never gets it, even when marked
    sys = await request(hooks, SID, "You are a title generator. You output ONLY a thread title.");
    assert.equal(sys.length, 1);
    const out = await hooks.tool.file_tasks.execute({ tasks: JSON.stringify([T(1), T(2), T(3)]) }, ctx());
    assert.match(out, /Filed 3 tasks/);
    const b1 = (await request(hooks))[1];
    assert.match(b1, /Current task: 1 of 3: Problem 1\n\nDetails 1: ERR-1/);
    await hooks.tool.task_note.execute({ id: 1, text: "cause: off-by-one" }, ctx());
    assert.equal((await request(hooks))[1], b1, "notes do not change the block within a task");
    const fin = await hooks.tool.finish_task.execute({ id: "1", summary: "fixed the off-by-one" }, ctx());
    assert.match(fin, /Next: task 2 of 3: Problem 2/);
    const b2 = (await request(hooks))[1];
    assert.match(b2, /Current task: 2 of 3/);
    assert.equal(stateOf(dir).tasks[0].summary, "fixed the off-by-one");
    const kinds = events(dir).map((e) => e.event);
    assert.ok(kinds.includes("filed") && kinds.includes("noted") && kinds.includes("finished") && kinds.filter((k) => k === "shown").length === 2);
  });

  test(`[${impl}] compaction: the list goes into the summarizer's prompt, not its system; the block refreshes after`, async () => {
    const { hooks, dir } = await make(impl);
    await hooks.tool.file_tasks.execute({ tasks: [T(1), T(2)] }, ctx());
    const b1 = (await request(hooks))[1];
    await hooks.tool.task_note.execute({ id: 1, text: "NOTE-AFTER-SNAPSHOT" }, ctx());
    const out = { context: [], prompt: undefined };
    await hooks["experimental.session.compacting"]({ sessionID: SID }, out);
    assert.equal(out.context.length, 1);
    assert.match(out.context[0], /1\. \[current, open\] Problem 1\n   - note: NOTE-AFTER-SNAPSHOT\n2\. \[open\] Problem 2/);
    assert.equal((await request(hooks)).length, 1, "the summarizer's own request gets no block");
    await hooks.event(ev("session.compacted", { sessionID: SID }));
    const b2 = (await request(hooks))[1];
    assert.notEqual(b2, b1);
    assert.match(b2, /Notes recorded for this task:\n- NOTE-AFTER-SNAPSHOT/);
    assert.equal(stateOf(dir).compactions, 1);
  });

  test(`[${impl}] idle: one follow-up per cycle, sent as a prompt; two nudges, move on, final pass, then silence`, async () => {
    const { hooks, client, dir } = await make(impl);
    await userMessage(hooks, "fix three things");
    await idleCycle(hooks);
    assert.equal(client.sent.length, 0, "nothing filed: no follow-up");
    await hooks.tool.file_tasks.execute({ tasks: [T(1), T(2)] }, ctx());
    await idleCycle(hooks);
    assert.equal(client.sent.length, 1, "status idle + session.idle = one follow-up");
    assert.equal(client.sent[0].path.id, SID);
    assert.deepEqual(client.sent[0].body.model, { providerID: "p", modelID: "m" });
    assert.match(client.sent[0].body.parts[0].text, /^Task 1 of 2 \(Problem 1\) is still open\./);
    await userMessage(hooks, client.sent[0].body.parts[0].text);           // it arrives
    assert.equal(stateOf(dir).delivered, 1);
    await idleCycle(hooks); await userMessage(hooks, client.sent[1].body.parts[0].text);
    await idleCycle(hooks);
    assert.match(client.sent[2].body.parts[0].text, /^Task 1 of 2 \(Problem 1\) is set aside as unfinished\.\n\nNext: task 2 of 2/);
    await userMessage(hooks, client.sent[2].body.parts[0].text);
    await hooks.tool.finish_task.execute({ id: 2, summary: "" }, ctx());   // final pass asked in the result
    await idleCycle(hooks);
    assert.equal(client.sent.length, 3, "final pass was in the tool result: no prompt");
    await idleCycle(hooks);
    assert.equal(client.sent.length, 3);
    const s = stateOf(dir);
    assert.deepEqual(s.tasks.map((t) => t.status), ["unfinished", "done"]);
    assert.equal(s.final_pass, "tool"); assert.equal(s.prompts, 3);
    assert.deepEqual(events(dir).filter((e) => e.event === "sent").length, 3);
  });

  test(`[${impl}] no follow-up after an error or an abort, or for a sub-agent session`, async () => {
    const { hooks, client } = await make(impl);
    await hooks.tool.file_tasks.execute({ tasks: [T(1)] }, ctx());
    await idleCycle(hooks, SID, { error: "MessageAbortedError" });
    assert.equal(client.sent.length, 0);
    await hooks.event(ev("session.status", { sessionID: SID, status: { type: "busy" } }));
    await hooks.event(ev("session.error", { sessionID: SID, error: { name: "APIError" } }));
    await hooks.event(ev("session.status", { sessionID: SID, status: { type: "idle" } }));
    assert.equal(client.sent.length, 0);
    await userMessage(hooks, "go on");
    await idleCycle(hooks);
    assert.equal(client.sent.length, 1, "a clean cycle after a new user message is driven again");
    const CHILD = "ses_child";
    await hooks.event(ev("session.created", { info: { id: CHILD, parentID: SID } }));
    await hooks.tool.file_tasks.execute({ tasks: [T(1)] }, ctx(CHILD));
    assert.equal((await request(hooks, CHILD)).length, 1, "no block for a sub-agent");
    await idleCycle(hooks, CHILD);
    assert.equal(client.sent.length, 1, "no follow-up for a sub-agent");
  });

  test(`[${impl}] file delivery: the follow-up is only recorded; a new process picks the state up`, async () => {
    const a = await make(impl, { delivery: "file" });
    await a.hooks.tool.file_tasks.execute({ tasks: [T(1), T(2)] }, ctx());
    await a.hooks.tool.task_note.execute({ id: 1, text: "n1" }, ctx());
    await idleCycle(a.hooks);
    assert.equal(a.client.sent.length, 0);
    const s = stateOf(a.dir);
    assert.equal(s.pending.kind, "nudge"); assert.equal(s.pending.task, 1);
    assert.match(s.pending.text, /^Task 1 of 2 \(Problem 1\) is still open\.[\s\S]*- n1/);
    // the outside driver runs `opencode run --session <id> "<pending.text>"`: a fresh plugin instance, same dir
    const mod = await import(IMPLS[impl]);
    const c2 = fakeClient();
    const h2 = await mod.TaskDriver({ client: c2, directory: "/w" }, { dir: a.dir, delivery: "file" });
    await h2["chat.message"]({ sessionID: SID }, { message: {}, parts: [{ type: "text", text: s.pending.text }] });
    assert.equal(stateOf(a.dir).pending, null); assert.equal(stateOf(a.dir).delivered, 1);
    await idleCycle(h2);
    const s2 = stateOf(a.dir);
    assert.equal(s2.pending.kind, "nudge"); assert.equal(s2.tasks[0].nudges, 2, "counters survive the process");
    await h2["chat.message"]({ sessionID: SID }, { message: {}, parts: [{ type: "text", text: "something else" }] });
    assert.equal(stateOf(a.dir).superseded, 1);
  });

  test(`[${impl}] auto delivery is "file" inside \`opencode run\`, "prompt" elsewhere`, async () => {
    const argv = process.argv;
    try {
      process.argv = ["bun", "/$bunfs/root/src/index.js", "run", "--format", "json", "hello"];
      let m = await make(impl, { delivery: "auto" });
      assert.equal(events(m.dir)[0].delivery, "file");
      process.argv = ["bun", "/$bunfs/root/src/index.js", "serve", "--port", "4096"];
      m = await make(impl, { delivery: "auto" });
      assert.equal(events(m.dir)[0].delivery, "prompt");
      process.argv = ["bun", "/$bunfs/root/src/index.js", "--log-level", "DEBUG", "run", "--format", "json", "hello"];
      m = await make(impl, { delivery: "auto" });
      assert.equal(events(m.dir)[0].delivery, "file", "global options before the subcommand");
      process.argv = ["bun", "/$bunfs/root/src/index.js", "serve", "--hostname", "run"];
      m = await make(impl, { delivery: "auto" });
      assert.equal(events(m.dir)[0].delivery, "prompt", "the first subcommand decides");
    } finally { process.argv = argv; }
  });

  test(`[${impl}] enforce mode: no tools, no injection; nudges from the mirrored todo list`, async () => {
    const { hooks, client, dir } = await make(impl, { mode: "enforce" });
    assert.equal(hooks.tool, undefined);
    assert.equal((await request(hooks)).length, 1);
    await idleCycle(hooks);
    assert.equal(client.sent.length, 0, "no todo list: inert");
    await hooks.event(ev("todo.updated", { sessionID: SID, todos: [{ id: "1", content: "fix A", status: "completed", priority: "high" }, { id: "2", content: "fix B", status: "pending", priority: "high" }] }));
    await idleCycle(hooks);
    assert.equal(client.sent.length, 1);
    assert.equal(client.sent[0].body.parts[0].text, "Your todo list still has open items:\n- [pending] fix B\n\nContinue working on them. If an item is already done or no longer needed, update the todo list to say so.");
    await idleCycle(hooks); await idleCycle(hooks);
    assert.equal(client.sent.length, 2, "two per item");
    const out = { context: [] };
    await hooks["experimental.session.compacting"]({ sessionID: SID }, out);
    assert.deepEqual(out.context, []);
    assert.deepEqual(stateOf(dir).todos.map((t) => t.status), ["completed", "pending"]);
  });

  test(`[${impl}] tasks mode: six tools; no done_when or evidence; the env var selects the mode`, async () => {
    const { hooks, dir } = await make(impl, { mode: "tasks" });
    assert.equal(events(dir)[0].mode, "tasks");
    assert.deepEqual(Object.keys(hooks.tool).sort(), ["add_task", "file_tasks", "finish_task", "give_up_task", "list_tasks", "task_note"]);
    for (const t of Object.values(hooks.tool)) for (const v of Object.values(t.args)) assert.equal(typeof v.type, "string");
    const item = hooks.tool.file_tasks.args.tasks.items;
    assert.deepEqual(Object.keys(item.properties), ["title", "details"]);
    assert.deepEqual(item.required, ["title", "details"]);
    assert.deepEqual(Object.keys(hooks.tool.add_task.args), ["title", "details"]);
    assert.deepEqual(Object.keys(hooks.tool.finish_task.args), ["id", "summary"]);
    assert.equal(hooks.tool.finish_task.description, "Mark a task done. Returns the next task.");
    assert.equal(hooks.tool.finish_task.args.summary.description, "Optional: a short note of what you changed. May be left empty.");
    assert.equal(hooks.tool.file_tasks.description, "Split the user's request into separate tasks, one per problem, and keep them in a task list outside the conversation. Call it before starting work when the request contains more than one separate problem. Write each task completely: every detail from the request that matters for it (symptoms, exact error text and quotes, expected behaviour, constraints, where to look), so it can be done from its own text alone. Returns the first task.");
    const all = JSON.stringify(Object.fromEntries(Object.entries(hooks.tool).map(([k, t]) => [k, { d: t.description, a: t.args }])));
    assert.doesNotMatch(all, /verif|checked|how to tell|done when|done_when|evidence/i);
    const viaEnv = await make(impl, { mode: "enforce" }, { OPENCODE_TASK_DRIVER: "tasks" });
    assert.equal(events(viaEnv.dir)[0].mode, "tasks");
    assert.deepEqual(Object.keys(viaEnv.hooks.tool.finish_task.args), ["id", "summary"]);
  });

  test(`[${impl}] tasks mode: planning block, finish without a summary, plain follow-ups, the final pass`, async () => {
    const { hooks, client, dir } = await make(impl);
    const sys = await request(hooks);
    assert.equal(sys.length, 2);
    assert.match(sys[1], /^<task_planning>\nIf the user's request contains more than one separate problem \(for example several bugs, or several changes that can each be made on their own\)/);
    assert.doesNotMatch(sys[1], /how to tell|checked/);
    await userMessage(hooks, "fix three things");
    const filedOut = await hooks.tool.file_tasks.execute({ tasks: [{ ...T(1), done_when: "check-1" }, T(2), T(3)] }, ctx());   // a done_when sent anyway: dropped
    assert.doesNotMatch(filedOut, /Done when|check-1/);
    assert.equal(stateOf(dir).tasks[0].done_when, undefined);
    const b1 = (await request(hooks))[1];
    assert.match(b1, /^<task_list>\n[\s\S]*Current task: 1 of 3: Problem 1\n\nDetails 1: ERR-1\n\nNotes recorded for this task: none yet\./);
    assert.ok(b1.includes("When a task is done, call finish_task with its id; the next task will then be given to you."));
    assert.doesNotMatch(b1, /verif|checked|Done when/);
    const fin = await hooks.tool.finish_task.execute({ id: 1 }, ctx());                          // no summary
    assert.match(fin, /^Task 1 marked done\.\n\nNext: task 2 of 3: Problem 2/);
    assert.equal(stateOf(dir).tasks[0].status, "done");
    await hooks.tool.task_note.execute({ id: 2, text: "cache.js sets no TTL" }, ctx());
    await idleCycle(hooks);
    assert.equal(client.sent.length, 1);
    assert.equal(client.sent[0].body.parts[0].text, "Task 2 of 3 (Problem 2) is still open.\n\nDetails 2: ERR-2\n\nNotes recorded for this task:\n- cache.js sets no TTL\n\nContinue working on this task. When it is done, call finish_task; if it cannot be done, call give_up_task with the reason.");
    await userMessage(hooks, client.sent[0].body.parts[0].text);
    await hooks.tool.finish_task.execute({ id: 2, summary: "set a 60 s TTL" }, ctx());
    const out = { context: [] };
    await hooks["experimental.session.compacting"]({ sessionID: SID }, out);
    assert.match(out.context[0], /1\. \[done\] Problem 1\n2\. \[done\] Problem 2 \(summary: set a 60 s TTL\)\n   - note: cache\.js sets no TTL\n3\. \[current, open\] Problem 3/);
    const last = await hooks.tool.finish_task.execute({ id: 3, summary: "" }, ctx());
    assert.match(last, /^Task 3 marked done\.\n\nAll tasks are closed \(3 done\)\.\nAs a last step, run the project's full test suite/);
    await idleCycle(hooks);
    assert.equal(client.sent.length, 1, "the final pass was in the tool result");
    const s = stateOf(dir);
    assert.equal(s.mode, "tasks"); assert.equal(s.final_pass, "tool");
    assert.deepEqual(s.tasks.map((t) => [t.status, t.summary]), [["done", null], ["done", "set a 60 s TTL"], ["done", null]]);
    // a session whose last task is set aside gets the final pass as a follow-up prompt
    const b = await make(impl);
    await b.hooks.tool.file_tasks.execute({ tasks: [T(1)] }, ctx());
    for (let i = 0; i < 3; i++) { await idleCycle(b.hooks); await userMessage(b.hooks, b.client.sent.at(-1).body.parts[0].text); }
    assert.equal(b.client.sent.length, 3);
    assert.match(b.client.sent[2].body.parts[0].text, /^Task 1 of 1 \(Problem 1\) is set aside as unfinished\.\nAll tasks are closed \(0 done, 1 set aside unfinished\)\.\nAs a last step, run the project's full test suite/);
    await idleCycle(b.hooks);
    assert.equal(b.client.sent.length, 3);
  });

  test(`[${impl}] dispose writes the state; hooks never throw`, async () => {
    const { hooks, dir } = await make(impl);
    await hooks.tool.file_tasks.execute({ tasks: [T(1)] }, ctx());
    await hooks.dispose();
    assert.equal(events(dir).at(-1).event, "disposed");
    await hooks.event(null); await hooks.event({ event: { type: "session.status" } });
    await hooks["experimental.chat.system.transform"](null, null);
    await hooks["chat.message"](null, null);
    assert.equal(await hooks.tool.list_tasks.execute({}, {}), "Error: no session");
    assert.match(await hooks.tool.finish_task.execute({ id: 9 }, ctx()), /^Error: there is no task 9/);
  });
}
