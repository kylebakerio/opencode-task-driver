// focus mode (0.3.0) through the opencode adapter: tools, the request, the git file list, the clean-slate view of the
// conversation (the model's and the summarizer's), and boundaries made by a tool call or by a follow-up.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const IMPLS = { src: "../src/plugin.js", dist: "../dist/opencode-task-driver.js" };
const SID = "ses_focus1";
const T = (n) => ({ title: `Problem ${n}`, details: `Details ${n}: ERR-${n}` });
const REQUEST = "Fix three things:\n1. ERR-1\n2. ERR-2\n3. ERR-3";

function gitRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "otd-git-"));
  const g = (...a) => spawnSync("git", a, { cwd: d, encoding: "utf8" });
  g("init", "-q"); fs.writeFileSync(path.join(d, "a.txt"), "one\n"); fs.writeFileSync(path.join(d, "c.txt"), "gone soon\n");
  g("add", "-A"); g("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "base");
  fs.writeFileSync(path.join(d, "pre.md"), "placed before the work began\n");   // untracked before the plugin loads
  return d;
}

async function make(impl, { opts = {}, directory = "/nonexistent-dir", messages = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otd-focus-"));
  const sent = [];
  const client = { session: {
    promptAsync: async (req) => { sent.push(req); return { data: undefined }; },
    ...(messages ? { messages: async () => ({ data: messages }) } : {}),
  } };
  delete process.env.OPENCODE_TASK_DRIVER;
  const mod = await import(IMPLS[impl]);
  const hooks = await mod.TaskDriver({ client, directory }, { dir, delivery: "prompt", ...opts });
  return { hooks, dir, sent };
}
const ev = (type, properties) => ({ event: { type, properties } });
const ctx = (messageID = "msg_tool") => ({ sessionID: SID, messageID, agent: "build" });
const stateOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, SID + ".json"), "utf8"));
const events = (dir) => fs.readFileSync(path.join(dir, ".events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const msg = (id, role, created, text, parts) => ({ info: { id, sessionID: SID, role, time: { created } }, parts: parts || [{ id: id + "-p", type: "text", text }] });
async function view(hooks, msgs) {
  await hooks["experimental.chat.messages.transform"]({}, { messages: msgs });
  const out = { system: ["You are opencode"] };
  await hooks["experimental.chat.system.transform"]({ sessionID: SID, model: {} }, out);
  return { msgs, system: out.system };
}
async function idle(hooks) {
  await hooks.event(ev("session.status", { sessionID: SID, status: { type: "busy" } }));
  await hooks.event(ev("message.updated", { info: { role: "assistant", sessionID: SID, finish: "stop", time: { created: 1, completed: 2 } } }));
  await hooks.event(ev("session.status", { sessionID: SID, status: { type: "idle" } }));
  await hooks.event(ev("session.idle", { sessionID: SID }));
  await new Promise((r) => setImmediate(r));
}

for (const impl of Object.keys(IMPLS)) {
  test(`[${impl}] focus is the default; finish_task / give_up_task take a handoff; file_tasks asks for dependency order`, async () => {
    const { hooks, dir } = await make(impl);
    assert.equal(events(dir)[0].mode, "focus");
    assert.deepEqual(Object.keys(hooks.tool.finish_task.args), ["id", "handoff"]);
    assert.deepEqual(Object.keys(hooks.tool.give_up_task.args), ["id", "reason", "handoff"]);
    // 0.3.1: the file map is on by default and the handoff asks for locations (0.3.0's wording: test/focus31-plugin.test.js, features off)
    assert.equal(hooks.tool.finish_task.args.handoff.description, "Where things are and what you changed, focused and terse: the files and functions that matter for the remaining tasks, how they connect, and any gotchas. No test-status report (the task list tracks status). Write \"none\" if nothing.");
    assert.match(hooks.tool.file_tasks.description, /List the tasks so that a task comes after any task it depends on\./);
    assert.match(hooks.tool.file_tasks.args.tasks.items.properties.details.description, /which other task's change it depends on, if any\.$/);
    for (const t of Object.values(hooks.tool)) for (const v of Object.values(t.args)) assert.equal(typeof v.type, "string");
    const all = JSON.stringify(Object.fromEntries(Object.entries(hooks.tool).map(([k, t]) => [k, { d: t.description, a: t.args }])));
    assert.doesNotMatch(all, /verif|checked|how to tell|done when|done_when|evidence/i);
    assert.doesNotMatch(all, /plugin|opencode|task.driver|\bdriver\b|state file|follow-up|nudge/i);
  });

  test(`[${impl}] the request: the stored session's first message, else the first message seen`, async () => {
    const stored = [msg("msg_u0", "user", 1, REQUEST), msg("msg_a0", "assistant", 2, "ok"), msg("msg_u1", "user", 3, "go on")];
    let m = await make(impl, { messages: stored });
    await m.hooks["chat.message"]({ sessionID: SID }, { message: {}, parts: [{ type: "text", text: "go on" }] });   // a later message seen first
    await m.hooks.tool.file_tasks.execute({ tasks: [T(1), T(2)] }, ctx());
    assert.equal(stateOf(m.dir).request, REQUEST);
    m = await make(impl);                                            // no client.session.messages: the first message seen
    await m.hooks["chat.message"]({ sessionID: SID }, { message: {}, parts: [{ type: "text", text: REQUEST }, { type: "text", text: "ignored part", ignored: true }] });
    await m.hooks["chat.message"]({ sessionID: SID }, { message: {}, parts: [{ type: "text", text: "second message" }] });
    await m.hooks.tool.file_tasks.execute({ tasks: [T(1), T(2)] }, ctx());
    assert.equal(stateOf(m.dir).request, REQUEST);
    m = await make(impl);                                            // seen only through messages.transform
    await view(m.hooks, [msg("msg_u0", "user", 1, REQUEST)]);
    await m.hooks.tool.file_tasks.execute({ tasks: [T(1)] }, ctx());
    assert.equal(stateOf(m.dir).request, REQUEST);
  });

  test(`[${impl}] the files list comes from git, relative to the start of the work, refreshed at each task start`, async () => {
    const ws = gitRepo();
    const { hooks, dir } = await make(impl, { directory: ws });
    await hooks.tool.file_tasks.execute({ tasks: [T(1), T(2), T(3)] }, ctx());
    let s = stateOf(dir);
    assert.deepEqual(s.files, [], "pre.md was there before the work began: not listed");
    assert.equal(s.git.start.length, 1);
    fs.writeFileSync(path.join(ws, "a.txt"), "two\n"); fs.mkdirSync(path.join(ws, "new")); fs.writeFileSync(path.join(ws, "new", "b.txt"), "b\n");
    fs.rmSync(path.join(ws, "c.txt"));
    await hooks.tool.finish_task.execute({ id: 1, summary: "", handoff: "a.txt holds the new value" }, ctx("msg_close1"));
    s = stateOf(dir);
    assert.deepEqual(s.files, [{ s: "M", p: "a.txt" }, { s: "D", p: "c.txt" }, { s: "?", p: "new/" }]);
    const block = (await view(hooks, [msg("msg_x", "assistant", 4e12, "x")])).system[0];
    assert.match(block, /Files changed so far \(from git, compared with the start of the work\):\n- modified: a\.txt\n- deleted: c\.txt\n- new, not yet added to git: new\/\n/);
    spawnSync("git", ["add", "-A"], { cwd: ws }); spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "wip"], { cwd: ws });
    await hooks.tool.finish_task.execute({ id: 2, summary: "", handoff: "none" }, ctx("msg_close2"));
    assert.deepEqual(stateOf(dir).files, [{ s: "M", p: "a.txt" }, { s: "D", p: "c.txt" }, { s: "A", p: "new/b.txt" }, { s: "A", p: "pre.md" }], "committed work still counts (diff against the start commit)");
    const outside = await make(impl, { directory: fs.mkdtempSync(path.join(os.tmpdir(), "otd-nogit-")) });
    await outside.hooks.tool.file_tasks.execute({ tasks: [T(1)] }, ctx());
    assert.equal(stateOf(outside.dir).files, null, "not a git repository: no list");
  });

  test(`[${impl}] clean slate: after finish_task the model's view starts at the next task, framed by the task context`, async () => {
    const { hooks, dir } = await make(impl, { messages: [msg("msg_u0", "user", 1, REQUEST)] });
    await hooks.tool.file_tasks.execute({ tasks: [T(1), T(2), T(3)] }, ctx("msg_file"));
    const t1 = [msg("msg_u0", "user", 1, REQUEST), msg("msg_file", "assistant", 2, "filing")];
    const v1 = await view(hooks, t1);
    assert.equal(v1.msgs.length, 2, "task 1 keeps the conversation it started in");
    assert.equal(v1.system.length, 1, "one system message");
    assert.match(v1.system[0], /^You are opencode\n\n<task_context>\nWe received the request below\. It is here for reference/);
    assert.match(v1.system[0], /The current task is task 1 of 3: Problem 1\n\nDetails 1: ERR-1/);
    const before = Date.now();
    const out = await hooks.tool.finish_task.execute({ id: 1, summary: "fixed it", handoff: "use helper fmt() in util.js" }, ctx("msg_close"));
    assert.match(out, /^Task 1 marked done\.\n\nNext: task 2 of 3: Problem 2/);
    const s = stateOf(dir);
    assert.equal(s.boundary.n, 1); assert.equal(s.boundary.message, "msg_close"); assert.ok(s.boundary.at >= before);
    assert.equal(s.tasks[0].handoff, "use helper fmt() in util.js");
    const stored = [msg("msg_u0", "user", 1, REQUEST), msg("msg_file", "assistant", 2, "filing"), msg("msg_close", "assistant", s.boundary.at, "finish_task(1)"), msg("msg_n", "assistant", s.boundary.at + 50, "on task 2")];
    const copy = JSON.parse(JSON.stringify(stored));
    const v2 = await view(hooks, stored);
    assert.deepEqual(v2.msgs.map((m) => m.info.id), ["msg-task-start-1", "msg_n"]);
    assert.equal(v2.msgs[0].parts[0].text, "We are now on task 2 of 3: Problem 2. The request, the task list with what the earlier tasks handed off, the files changed so far and the full text of this task are in the task context above. Work on this task now.");
    assert.equal(v2.system.length, 1);
    const block = v2.system[0];
    assert.ok(block.indexOf("<request>") < block.indexOf("The tasks, in order:") && block.indexOf("The tasks, in order:") < block.indexOf("The current task is task 2 of 3"), "request, list, current task last");
    assert.match(block, /1\. \[done\] Problem 1\n   Handoff: use helper fmt\(\) in util\.js\n2\. \[current\] Problem 2/);
    const ev2 = events(dir).filter((e) => e.event === "boundary" || e.event === "view");
    assert.deepEqual(ev2.map((e) => [e.event, e.by || e.kind, e.n || e.boundary]), [["boundary", "tool", 1], ["view", "request", 1]]);
    // the same view again: byte-identical (the prompt cache keeps its prefix)
    const again = await view(hooks, JSON.parse(JSON.stringify(copy)));
    assert.deepEqual(again.msgs, v2.msgs); assert.equal(again.system[0], block);
    const twice = await view(hooks, again.msgs);                     // applying it to its own output changes nothing
    assert.deepEqual(twice.msgs.map((m) => m.parts.length), [1, 1]);
  });

  test(`[${impl}] the summarizer sees only the current task's conversation; a pre-task previous summary is replaced by our prompt`, async () => {
    const { hooks, dir } = await make(impl, { messages: [msg("msg_u0", "user", 1, REQUEST)] });
    await hooks.tool.file_tasks.execute({ tasks: [T(1), T(2)] }, ctx("msg_file"));
    // a compaction during task 1 (before any boundary): opencode's own prompt + our context
    let out = { context: [], prompt: undefined };
    await hooks["experimental.session.compacting"]({ sessionID: SID }, out);
    assert.equal(out.prompt, undefined); assert.equal(out.context.length, 1);
    const head1 = [msg("msg_u0", "user", 1, REQUEST), msg("msg_w", "assistant", 2, "task 1 work")];
    const v0 = await view(hooks, head1);
    assert.equal(v0.msgs.length, 2, "no boundary yet: the summarizer gets the whole head");
    assert.equal(v0.system.length, 1, "the summarizer's request gets no task context");
    await hooks.event(ev("session.compacted", { sessionID: SID }));
    assert.ok(stateOf(dir).compacted_at > 0);
    await new Promise((r) => setTimeout(r, 5));
    await hooks.tool.finish_task.execute({ id: 1, summary: "", handoff: "none" }, ctx("msg_close"));
    const at = stateOf(dir).boundary.at;
    // the next compaction (inside task 2): its head still holds task 1's messages; the view drops them
    out = { context: [], prompt: undefined };
    await hooks["experimental.session.compacting"]({ sessionID: SID }, out);
    assert.match(out.prompt, /^Summarize the conversation below so that another coding agent can continue the work\.\n\nThis session keeps a task list outside the conversation and works each task in its own conversation; the conversation to summarize covers only the current task \(task 2 of 2: Problem 2\)/);
    assert.deepEqual(out.context, [], "the prompt replaces opencode's template and its previous summary");
    const head2 = [msg("msg_w", "assistant", 2, "task 1 work"), msg("msg_close", "assistant", at - 1, "finish"), msg("msg_t2", "assistant", at + 10, "task 2 work")];
    const v2 = await view(hooks, head2);
    assert.deepEqual(v2.msgs.map((m) => m.info.id), ["msg-task-start-1", "msg_t2"]);
    assert.equal(v2.system.length, 1);
    assert.ok(events(dir).some((e) => e.event === "view" && e.kind === "summarizer" && e.dropped === 2));
    // after that compaction, a second one inside task 2 keeps opencode's own prompt (its previous summary is task 2's)
    await hooks.event(ev("session.compacted", { sessionID: SID }));
    out = { context: [], prompt: undefined };
    await hooks["experimental.session.compacting"]({ sessionID: SID }, out);
    assert.equal(out.prompt, undefined); assert.equal(out.context.length, 1);
    await view(hooks, [msg("msg_t3", "assistant", 4e12, "x")]);   // consume the summarizer mark
  });

  test(`[${impl}] a task set aside by a follow-up: the follow-up opens the next task's view`, async () => {
    const { hooks, dir, sent } = await make(impl, { opts: { maxNudgesPerTask: 0 } });
    await hooks.tool.file_tasks.execute({ tasks: [T(1), T(2)] }, ctx("msg_file"));
    await idle(hooks);
    assert.equal(sent.length, 1);
    const text = sent[0].body.parts[0].text;
    assert.match(text, /^Task 1 of 2 \(Problem 1\) is set aside as unfinished\.\n\nNext: task 2 of 2: Problem 2/);
    const s = stateOf(dir);
    assert.equal(s.boundary.message, null); assert.equal(s.boundary.start_text, null);
    assert.ok(events(dir).some((e) => e.event === "boundary" && e.by === "followup"));
    await hooks["chat.message"]({ sessionID: SID }, { message: {}, parts: [{ type: "text", text }] });
    const v = await view(hooks, [msg("msg_old", "assistant", s.boundary.at - 5, "old"), msg("msg_fu", "user", s.boundary.at + 5, text)]);
    assert.deepEqual(v.msgs.map((m) => m.info.id), ["msg_fu"]);
    assert.equal(v.msgs[0].parts.length, 1);
  });

  test(`[${impl}] tasks mode is untouched by all of this: no request, no git, no view change`, async () => {
    const ws = gitRepo();
    const { hooks, dir } = await make(impl, { opts: { mode: "tasks" }, directory: ws, messages: [msg("msg_u0", "user", 1, REQUEST)] });
    await hooks.tool.file_tasks.execute({ tasks: [T(1), T(2)] }, ctx());
    await hooks.tool.finish_task.execute({ id: 1, summary: "x", handoff: "ignored" }, ctx("msg_close"));
    const s = stateOf(dir);
    assert.ok(!("request" in s) && !("boundary" in s) && !("files" in s) && !("handoff" in s.tasks[0]));
    const list = [msg("msg_u0", "user", 1, REQUEST), msg("msg_close", "assistant", 2, "finish")];
    const v = await view(hooks, list);
    assert.equal(v.msgs.length, 2);
    assert.match(v.system[1], /^<task_list>/);
    assert.deepEqual(Object.keys(hooks.tool.finish_task.args), ["id", "summary"]);
  });
}

// a `git` first on PATH that counts its calls, then runs the real one
function countingGit() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "otd-gitbin-"));
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const count = path.join(bin, "calls");
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\necho "$*" >> "${count}"\nexec "${real}" "$@"\n`, { mode: 0o755 });
  return { bin, calls: () => (fs.existsSync(count) ? fs.readFileSync(count, "utf8").trim().split("\n").filter(Boolean).length : 0) };
}

for (const impl of Object.keys(IMPLS)) {
  test(`[${impl}] focus: finish_task takes only id and handoff; give_up_task keeps the reason`, async () => {
    const { hooks } = await make(impl);
    assert.deepEqual(Object.keys(hooks.tool.finish_task.args), ["id", "handoff"]);
    assert.deepEqual(Object.keys(hooks.tool.give_up_task.args), ["id", "reason", "handoff"]);
  });

  test(`[${impl}] focus: git runs at the first task start and at boundaries, not at every idle`, async () => {
    const ws = gitRepo();
    const g = countingGit();
    const saved = process.env.PATH;
    process.env.PATH = `${g.bin}:${saved}`;
    try {
      const { hooks, dir } = await make(impl, { directory: ws });
      await hooks.tool.file_tasks.execute({ tasks: [T(1), T(2)] }, ctx());
      const afterFiling = g.calls();
      assert.ok(afterFiling > 0, "the snapshot and the first list");
      await idle(hooks);                                     // a follow-up for task 1: no boundary
      assert.equal(stateOf(dir).pending.kind, "nudge");
      assert.equal(g.calls(), afterFiling, "no git at an idle that keeps the same task");
      await hooks.tool.finish_task.execute({ id: 1, handoff: "none" }, ctx("msg_close"));
      assert.ok(g.calls() > afterFiling, "the boundary refreshes the list");
      const atBoundary = g.calls();
      await hooks.tool.task_note.execute({ id: 2, text: "n" }, ctx());
      await idle(hooks);
      assert.equal(g.calls(), atBoundary);
    } finally { process.env.PATH = saved; }
  });
}

// Real-model finding (11-24): a second leading system message is rejected by some chat templates (Qwen3.8 Flash-Next on
// llama.cpp --jinja: "System message must be at the beginning"); opencode then retries the step without the block. In
// focus mode the block goes INTO opencode's system prompt, so the request keeps exactly one system message.
for (const impl of Object.keys(IMPLS)) {
  test(`[${impl}] focus: the block is appended to the system prompt (one element in, one element out), byte-stable within a task`, async () => {
    const { hooks } = await make(impl, { messages: [msg("msg_u0", "user", 1, REQUEST)] });
    const sys = async (base = "You are opencode, an interactive CLI tool.") => {
      await hooks["experimental.chat.messages.transform"]({}, { messages: [msg("msg_x", "assistant", 4e12, "x")] });
      const out = { system: [base] };
      await hooks["experimental.chat.system.transform"]({ sessionID: SID, model: {} }, out);
      return out.system;
    };
    let s = await sys();
    assert.equal(s.length, 1);
    assert.ok(s[0].startsWith("You are opencode, an interactive CLI tool.\n\n<task_planning>\n"), s[0].slice(0, 80));
    await hooks.tool.file_tasks.execute({ tasks: [T(1), T(2)] }, ctx("msg_file"));
    const a = await sys(), b = await sys();
    assert.equal(a.length, 1);
    assert.ok(a[0].startsWith("You are opencode, an interactive CLI tool.\n\n<task_context>\n") && a[0].endsWith("</task_context>"));
    assert.equal(a[0], b[0], "byte-stable within a task");
    // the summarizer and the title agent still get nothing
    await hooks["experimental.session.compacting"]({ sessionID: SID }, { context: [], prompt: undefined });
    await hooks["experimental.chat.messages.transform"]({}, { messages: [msg("msg_y", "assistant", 4e12, "y")] });
    const sumOut = { system: ["You are a summarizer."] };
    await hooks["experimental.chat.system.transform"]({ sessionID: SID, model: {} }, sumOut);
    assert.deepEqual(sumOut.system, ["You are a summarizer."]);
    assert.deepEqual(await sys("You are a title generator. You output ONLY a thread title."), ["You are a title generator. You output ONLY a thread title."]);
    assert.equal((await sys()).length, 1, "the main request that follows takes the mark");
    // an empty system array: the block becomes its only element (still one system message)
    await hooks["experimental.chat.messages.transform"]({}, { messages: [msg("msg_z", "assistant", 4e12, "z")] });
    const empty = { system: [] };
    await hooks["experimental.chat.system.transform"]({ sessionID: SID, model: {} }, empty);
    assert.equal(empty.system.length, 1); assert.ok(empty.system[0].startsWith("<task_context>"));
  });

  test(`[${impl}] tasks mode keeps 0.2.0's separate element (unchanged; compat pins it)`, async () => {
    const { hooks } = await make(impl, { opts: { mode: "tasks" } });
    const s = await view(hooks, [msg("msg_x", "assistant", 4e12, "x")]);
    assert.equal(s.system.length, 2); assert.ok(s.system[1].startsWith("<task_planning>"));
  });
}
