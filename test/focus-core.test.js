// focus mode (0.3.0), the state machine: the task context, handoffs, boundaries and the clean-slate view.
import test from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/core.js";

const T = (n) => ({ title: `Problem ${n}`, details: `Details of problem ${n}: the "exact" error text ERR-${n}.` });
const REQUEST = "There are three problems:\n1. ERR-1\n2. ERR-2\n3. ERR-3";
const focused = (n = 3, at = { request: REQUEST, git: { top: "/w", base: "abc", start: [] }, files: [] }) => {
  const s = core.newState("ses_f", "focus");
  core.fileTasks(s, Array.from({ length: n }, (_, i) => T(i + 1)), at);
  return s;
};
const NO_CHECKS = /verif|checked|how to tell|done when|done_when|evidence/i;
const PLAIN = /plugin|opencode|task.driver|\bdriver\b|state file|follow-up|nudge|automat/i;
const RULES = "When a task is done, call finish_task with its id and a handoff: what the remaining tasks need to know from this one. The next task then starts in a fresh conversation. If a task cannot be done, call give_up_task with its id, the reason and a handoff.";
const msg = (id, role, created, text, extra = {}) => ({ info: { id, sessionID: "ses_f", role, time: { created }, ...extra }, parts: [{ id: id + "-p", type: "text", text }] });

test("focus is the default mode; its state carries the request, git snapshot, files, boundary", () => {
  const s = core.newState("x");
  assert.equal(s.mode, "focus");
  for (const k of ["request", "git", "files", "boundary", "compacted_at"]) assert.ok(k in s, k);
  assert.ok(!("request" in core.newState("x", "tasks")), "the tasks-mode state is unchanged");
});

test("the focus planning block asks for dependency order and says each task starts fresh", () => {
  const p = core.systemBlock(core.newState("x", "focus"));
  assert.equal(p, core.PLANNING_BLOCK_FOCUS);
  assert.ok(p.includes("Order the tasks so that a task comes after any task it depends on. If a task depends on a change made in another task (for example a button, a function or a field that the other task adds), say so in its details."));
  assert.ok(p.includes("Each task after the first starts in a fresh conversation that shows the request, the task list with what the earlier tasks handed off, the files changed so far, and the task itself."));
  assert.doesNotMatch(p, NO_CHECKS); assert.doesNotMatch(p, PLAIN);
});

test("file_tasks keeps the request (clipped at 32,000 characters), the git snapshot and the files; tasks get a handoff slot", () => {
  const s = focused();
  assert.equal(s.request, REQUEST);
  assert.deepEqual(s.git, { top: "/w", base: "abc", start: [] });
  assert.deepEqual(s.files, []);
  assert.deepEqual(Object.keys(s.tasks[0]), ["id", "title", "details", "status", "notes", "summary", "reason", "nudges", "closed_by", "handoff"]);
  const big = core.newState("x", "focus");
  core.fileTasks(big, [T(1)], { request: "x".repeat(40000) });
  assert.equal(big.request.length, 32000 + "\n[... the rest of the request is cut here]".length);
  assert.ok(big.request.endsWith("\n[... the rest of the request is cut here]"));
  const out = core.fileTasks(core.newState("y", "focus"), [T(1), T(2)]).output;
  assert.ok(out.endsWith(`Work on the tasks one at a time. ${RULES}`), out);
  const t = core.newState("t", "tasks");
  core.fileTasks(t, [T(1)], { request: REQUEST, files: [] });
  assert.ok(!("request" in t) && !("handoff" in t.tasks[0]), "tasks mode ignores all of it");
});

test("the task context: request first (as background), the list with handoffs, the files, the current task last", () => {
  const s = focused();
  core.finishTask(s, 1, "fixed the parser", undefined, "parse() now returns null on empty input; run `npm test -- parse`.\nDo not touch cache.js.");
  core.markBoundary(s, 1, { at: 1000, message: "msg_9", files: [{ s: "M", p: "src/parse.js" }, { s: "?", p: "test/parse.test.js" }], tool: true });
  const b = core.systemBlock(s);
  assert.equal(b, [
    "<task_context>",
    "We received the request below. It is here for reference: we broke it down into the tasks listed after it and are working through them one at a time, so the parts of it outside the current task are separate tasks.",
    "",
    "<request>",
    REQUEST,
    "</request>",
    "",
    "The tasks, in order:",
    "1. [done] Problem 1",
    "   Handoff: parse() now returns null on empty input; run `npm test -- parse`.",
    "   Do not touch cache.js.",
    "2. [current] Problem 2",
    "3. [open] Problem 3",
    "",
    "Files changed so far (from git, compared with the start of the work):",
    "- modified: src/parse.js",
    "- new, not yet added to git: test/parse.test.js",
    "",
    "The current task is task 2 of 3: Problem 2",
    "",
    T(2).details,
    "",
    "Notes recorded for this task: none yet.",
    "",
    RULES,
    "Use task_note to record findings and progress for the current task (notes are kept with the task list), add_task if you find another separate problem, and list_tasks to see the whole list.",
    "</task_context>",
  ].join("\n"));
  core.taskNote(s, 2, "cache.js sets no TTL");
  assert.equal(core.systemBlock(s), b, "byte-identical within a task");
  assert.doesNotMatch(b.replace(REQUEST, ""), PLAIN);
  assert.doesNotMatch(b, NO_CHECKS);
});

test("the task context without a request, with no changed files, with unknown files, and with everything closed", () => {
  const s = focused(2, { files: [] });
  let b = core.systemBlock(s);
  assert.match(b, /^<task_context>\nWe received a request and broke it down into the tasks below; we are working through them one at a time\.\n\nThe tasks, in order:\n1\. \[current\] Problem 1\n2\. \[open\] Problem 2\n\nFiles changed so far: none\.\n\nThe current task is task 1 of 2/);
  s.files = null; s.compactions += 1;
  assert.doesNotMatch(core.systemBlock(s), /Files changed/, "unknown (no git): no files section");
  core.giveUpTask(s, 1, "needs a service that is not running", undefined, "none");
  core.taskNote(s, 2, "half done: the form posts twice");
  s.tasks[1].status = "unfinished"; s.tasks[1].closed_by = "driver";
  s.files = Array.from({ length: 103 }, (_, i) => ({ s: "M", p: `f${i}.js` }));
  b = core.systemBlock(s);
  assert.match(b, /The tasks, all now closed:\n1\. \[given up\] Problem 1\n   Reason: needs a service that is not running\n   Handoff: none\n2\. \[set aside: unfinished\] Problem 2\n   Notes:\n   - half done: the form posts twice\n/);
  assert.match(b, /- modified: f99\.js\n- \.\.\. and 3 more\n<\/task_context>$/);
});

test("handoffs: kept whole (no 2,000-character rule), only in focus mode", () => {
  const s = focused(2);
  const long = "h".repeat(5000);
  core.finishTask(s, 1, "", undefined, long);
  assert.equal(s.tasks[0].handoff, long);
  core.giveUpTask(s, 2, "blocked", undefined, "  ");
  assert.equal(s.tasks[1].handoff, null);
  const t = core.newState("t", "tasks");
  core.fileTasks(t, [T(1)]);
  core.finishTask(t, 1, "x", undefined, "ignored");
  assert.ok(!("handoff" in t.tasks[0]));
});

test("markBoundary: only when the current task changes; the start message names the next task, or carries the final pass", () => {
  const s = focused(2);
  assert.equal(core.markBoundary(s, 1, { at: 5, tool: true }), null, "same task: no boundary");
  core.finishTask(s, 1);
  const b = core.markBoundary(s, 1, { at: 1000, message: "msg_a", files: [{ s: "M", p: "a.js" }], tool: true });
  assert.deepEqual(b, { n: 1, task: 2, at: 1000, message: "msg_a", start_text: "We are now on task 2 of 2: Problem 2. The request, the task list with what the earlier tasks handed off, the files changed so far and the full text of this task are in the task context above. Work on this task now." });
  assert.deepEqual(s.files, [{ s: "M", p: "a.js" }]);
  core.finishTask(s, 2);                                  // the last one: the final pass is asked in the tool result
  const fin = core.markBoundary(s, 2, { at: 2000, message: "msg_b", tool: true });
  assert.equal(fin.n, 2); assert.equal(fin.task, 0);
  assert.match(fin.start_text, /^All tasks are closed \(2 done\)\.\nAs a last step, run the project's full test suite/);
  assert.deepEqual(s.files, [{ s: "M", p: "a.js" }], "files undefined: the last list is kept");
  // the plugin moved on (set a task aside): the follow-up itself opens the view
  const d = focused(2);
  d.tasks[0].nudges = 2;
  const act = core.decide(d);
  assert.equal(act.kind, "next");
  const db = core.markBoundary(d, 1, { at: 3000, message: null, files: [], tool: false });
  assert.equal(db.start_text, null); assert.equal(db.task, 2);
  const t = core.newState("t", "tasks"); core.fileTasks(t, [T(1), T(2)]); core.finishTask(t, 1);
  assert.equal(core.markBoundary(t, 1, { at: 1, tool: true }), null, "tasks mode never marks one");
});

test("viewMessages: drops everything before the boundary (by time and by the closing message), opens with the start message", () => {
  const s = focused(3);
  const msgs = [
    msg("msg_u0", "user", 100, "the request", { agent: "build", model: { providerID: "p", modelID: "m" } }),
    msg("msg_a1", "assistant", 200, "working on task 1"),
    msg("msg_a2", "assistant", 300, "calling finish_task"),
    msg("msg_a3", "assistant", 1500, "looking at task 2"),
  ];
  assert.equal(core.viewMessages(s, msgs), null, "no boundary yet: unchanged");
  core.finishTask(s, 1);
  core.markBoundary(s, 1, { at: 1000, message: "msg_a2", tool: true });
  const v = core.viewMessages(s, msgs);
  assert.deepEqual(v.map((m) => m.info.id), ["msg-task-start-1", "msg_a3"]);
  assert.equal(v[0].info.role, "user"); assert.equal(v[0].info.agent, "build"); assert.deepEqual(v[0].info.model, { providerID: "p", modelID: "m" });
  assert.equal(v[0].parts[0].text, s.boundary.start_text); assert.equal(v[0].parts[0].synthetic, true);
  assert.equal(msgs.length, 4, "the input list is not changed by the pure function");
  // the closing message is dropped by id even when its clock is later than the boundary
  const late = [msg("msg_a2", "assistant", 5000, "finish_task"), msg("msg_a4", "assistant", 6000, "next")];
  assert.deepEqual(core.viewMessages(s, late).map((m) => m.info.id), ["msg-task-start-1", "msg_a4"]);
  // a user message first (a follow-up, or opencode's compaction request): the start text goes in front of it
  const u = [msg("msg_a1", "assistant", 200, "old"), msg("msg_u5", "user", 2000, "Yes, please do so."), msg("msg_a5", "assistant", 2100, "ok")];
  const vu = core.viewMessages(s, u);
  assert.deepEqual(vu.map((m) => m.info.id), ["msg_u5", "msg_a5"]);
  assert.deepEqual(vu[0].parts.map((p) => p.text), [s.boundary.start_text + "\n", "Yes, please do so."]);
  assert.equal(u[1].parts.length, 1, "the original message object is not modified");
  assert.deepEqual(core.viewMessages(s, vu).map((m) => m.parts.length), [2, 1], "idempotent: applied to its own output it adds nothing");
  assert.deepEqual(core.viewMessages(s, v).map((m) => m.info.id), ["msg-task-start-1", "msg_a3"]);
  // nothing after the boundary yet: just the start message
  assert.deepEqual(core.viewMessages(s, msgs.slice(0, 3)).map((m) => m.info.id), ["msg-task-start-1"]);
  // messages without a time are kept (never guessed away)
  assert.equal(core.viewMessages(s, [{ info: { id: "x", role: "assistant" }, parts: [] }]).length, 2);
});

test("viewMessages on opencode's post-compaction order: compaction request, summary, kept tail (older), later messages", () => {
  const s = focused(2);
  core.finishTask(s, 1);
  core.markBoundary(s, 1, { at: 1000, message: "msg_close", tool: true });
  // a compaction AFTER the boundary: [compaction request 3000, summary 3001, tail 900 (pre) + 1200 (post), 3100]
  const after = [msg("msg_c", "user", 3000, ""), msg("msg_s", "assistant", 3001, "## Summary"), msg("msg_t1", "assistant", 900, "pre"), msg("msg_t2", "assistant", 1200, "post"), msg("msg_n", "user", 3100, "Continue if you have next steps")];
  after[0].parts = [{ id: "c", type: "compaction", auto: true }];
  const v = core.viewMessages(s, after);
  assert.deepEqual(v.map((m) => m.info.id), ["msg_c", "msg_s", "msg_t2", "msg_n"]);
  assert.equal(v[0].parts[0].text, s.boundary.start_text + "\n");
  assert.equal(v[0].parts[1].type, "compaction");
  // a compaction BEFORE the boundary: its request, summary and tail all predate it
  const before = [msg("msg_c0", "user", 500, ""), msg("msg_s0", "assistant", 501, "## Old summary"), msg("msg_t0", "assistant", 400, "old tail"), msg("msg_close", "assistant", 800, "finish"), msg("msg_x", "assistant", 1100, "task 2 work")];
  assert.deepEqual(core.viewMessages(s, before).map((m) => m.info.id), ["msg-task-start-1", "msg_x"]);
});

test("a boundary the plugin made (task set aside) opens with its follow-up; a non-user first message gets a plain opener", () => {
  const s = focused(2);
  s.tasks[0].nudges = 2;
  core.decide(s);
  core.markBoundary(s, 1, { at: 1000, message: null, tool: false });
  const v = core.viewMessages(s, [msg("msg_a", "assistant", 900, "stopping"), msg("msg_f", "user", 1100, "Task 1 of 2 (Problem 1) is set aside as unfinished.")]);
  assert.deepEqual(v.map((m) => m.info.id), ["msg_f"]);
  assert.equal(v[0].parts.length, 1, "no extra text in front of the follow-up");
  const w = core.viewMessages(s, [msg("msg_b", "assistant", 1200, "hm")]);
  assert.deepEqual(w.map((m) => m.parts[0].text), ["Continue with the current task.", "hm"]);
});

test("compaction in focus mode: the context names the current task's conversation; the whole prompt is replaced only when opencode's previous summary predates the task", () => {
  const s = focused(3);
  core.taskNote(s, 1, "parse.js:40");
  core.finishTask(s, 1, "", undefined, "parse() returns null on empty input");
  core.markBoundary(s, 1, { at: 1000, message: "m", tool: true });
  core.taskNote(s, 2, "cache.js has no TTL");
  const c = core.compactionContext(s);
  assert.match(c, /^This session keeps a task list outside the conversation and works each task in its own conversation; the conversation to summarize covers only the current task \(task 2 of 3: Problem 2\)\./);
  assert.match(c, /\n1\. \[done\] Problem 1 \(handoff: parse\(\) returns null on empty input\)\n2\. \[current, open\] Problem 2\n   - note: cache\.js has no TTL\n3\. \[open\] Problem 3$/);
  assert.ok(!c.includes("parse.js:40"), "earlier tasks' notes stay out of the summarizer's prompt");
  assert.equal(core.priorSummaryBeforeBoundary(s), false, "no compaction yet");
  s.compacted_at = 500;
  assert.equal(core.priorSummaryBeforeBoundary(s), true, "the last summary was written before task 2 began");
  s.compacted_at = 1500;
  assert.equal(core.priorSummaryBeforeBoundary(s), false, "a summary written within task 2 is carried forward as usual");
  const p = core.summarizerPrompt(s);
  assert.ok(p.startsWith("Summarize the conversation below so that another coding agent can continue the work.\n\n" + c));
  assert.match(p, /## Goal\n## Done so far\n## In progress\n## Next steps\n## Relevant files/);
  for (const t of [c, p]) { assert.doesNotMatch(t, PLAIN); assert.doesNotMatch(t, NO_CHECKS); }
  const t = core.newState("t", "tasks"); core.fileTasks(t, [T(1)]); t.compacted_at = 1; t.boundary = { at: 5 };
  assert.equal(core.priorSummaryBeforeBoundary(t), false);
});

test("focus follow-ups ask for a handoff; every focus text is plain and asks for no per-task checks", () => {
  const s = focused(2);
  const n1 = core.decide(s);
  assert.equal(n1.text, `Task 1 of 2 (Problem 1) is still open.\n\n${T(1).details}\n\nContinue working on this task. When it is done, call finish_task with a handoff for the remaining tasks; if it cannot be done, call give_up_task with the reason and a handoff.`);
  core.decide(s);
  const mv = core.decide(s);
  assert.equal(mv.text, `Task 1 of 2 (Problem 1) is set aside as unfinished.\n\nNext: task 2 of 2: Problem 2\n\n${T(2).details}\n\nWork on this task now. ${RULES}`);
  const texts = [core.PLANNING_BLOCK_FOCUS, n1.text, mv.text, core.systemBlock(s), core.compactionContext(s), core.summarizerPrompt(s),
    core.finishTask(s, 2, "", undefined, "none").output, core.listTasks(s).output];
  for (const t of texts) { assert.doesNotMatch(t, NO_CHECKS, t); assert.doesNotMatch(t, PLAIN, t); }
});

test("a compaction opencode starts right at a boundary summarizes nothing of the new task and is left out of the view", () => {
  const s = focused(2);
  core.finishTask(s, 1);
  core.markBoundary(s, 1, { at: 1000, message: "msg_close", tool: true });
  // the summarizer's view of that compaction: only the task's start
  const sv = core.viewMessages(s, [msg("msg_a", "assistant", 900, "task 1 work"), msg("msg_close", "assistant", 950, "finish")]);
  assert.deepEqual(sv.map((m) => m.info.id), ["msg-task-start-1"]);
  assert.equal(core.noteSummarizerView(s, sv), true);
  const hollowAt = s.boundary.hollow_at;
  assert.ok(hollowAt > 0);
  assert.equal(core.noteSummarizerView(s, sv), false, "noted once");
  // opencode's list after it: [compaction request, summary, opencode's continue message, then task 2's own work]
  s.boundary.hollow_at = 1200;
  const req = { info: { id: "msg_c", sessionID: "ses_f", role: "user", time: { created: 1100 } }, parts: [{ id: "c", type: "compaction", auto: true }] };
  const sum = { info: { id: "msg_s", sessionID: "ses_f", role: "assistant", time: { created: 1300 }, summary: true, parentID: "msg_c" }, parts: [{ id: "s", type: "text", text: "## Objective\n- (none)" }] };
  const cont = { info: { id: "msg_k", sessionID: "ses_f", role: "user", time: { created: 1400 } }, parts: [{ id: "k", type: "text", synthetic: true, metadata: { compaction_continue: true }, text: "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed." }] };
  const work = msg("msg_w", "assistant", 1500, "task 2 work");
  const v = core.viewMessages(s, [req, sum, cont, work]);
  assert.deepEqual(v.map((m) => m.info.id), ["msg-task-start-1", "msg_w"]);
  assert.equal(v[0].parts[0].text, s.boundary.start_text);
  // a later compaction inside task 2 (it summarized task 2's own work) stays in view
  const req2 = { ...req, info: { ...req.info, id: "msg_c2", time: { created: 3000 } } };
  const sum2 = { ...sum, info: { ...sum.info, id: "msg_s2", parentID: "msg_c2", time: { created: 3100 } } };
  const cont2 = { ...cont, info: { ...cont.info, id: "msg_k2", time: { created: 3200 } } };
  assert.deepEqual(core.viewMessages(s, [req2, sum2, cont2]).map((m) => m.info.id), ["msg_c2", "msg_s2", "msg_k2"]);
  // a summarizer view with real task-2 messages is not hollow
  const t = focused(2); core.finishTask(t, 1); core.markBoundary(t, 1, { at: 1000, message: "x", tool: true });
  assert.equal(core.noteSummarizerView(t, core.viewMessages(t, [msg("msg_w", "assistant", 1500, "work")])), false);
  assert.equal(t.boundary.hollow_at, undefined);
});

test("focus: finish_task keeps one prose field, the handoff; the task list and the compaction context show it", () => {
  const s = focused(3);
  core.finishTask(s, 1, "a summary sent anyway", undefined, "use fmt() from util.js");
  assert.equal(s.tasks[0].summary, null, "no summary in focus mode");
  assert.equal(s.tasks[0].handoff, "use fmt() from util.js");
  core.markBoundary(s, 1, { at: 1000, message: "m", files: [], tool: true });
  const b = core.systemBlock(s);
  assert.match(b, /\n1\. \[done\] Problem 1\n   Handoff: use fmt\(\) from util\.js\n2\. \[current\] Problem 2\n/);
  assert.doesNotMatch(b, /Summary:/);
  assert.match(core.compactionContext(s), /\n1\. \[done\] Problem 1 \(handoff: use fmt\(\) from util\.js\)\n2\. \[current, open\] Problem 2/);
  const t = core.newState("t", "tasks"); core.fileTasks(t, [T(1)]); core.finishTask(t, 1, "kept");
  assert.equal(t.tasks[0].summary, "kept", "tasks mode keeps its summary");
});
