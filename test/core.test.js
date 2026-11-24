import test from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/core.js";

const T = (n) => ({ title: `Problem ${n}`, details: `Details of problem ${n}: the "exact" error text ERR-${n}.` });
const filed = (n = 3, mode = "tasks") => { const s = core.newState("ses_x", mode); core.fileTasks(s, Array.from({ length: n }, (_, i) => T(i + 1))); return s; };

const PLANNING = [
  "<task_planning>",
  "If the user's request contains more than one separate problem (for example several bugs, or several changes that can each be made on their own), call the file_tasks tool before you start working, with one task per problem.",
  "Write each task out completely and losslessly: put every detail from the request that matters for that problem into the task (symptoms, exact error messages and quoted text, expected behaviour, constraints, names of files, functions or features and where to look), so that the task can be done later from its own text without re-reading the request. Do not shorten or summarize details away; when unsure whether a detail matters, include it.",
  "After filing, work on the tasks one at a time, in order.",
  "If the request is a single problem, do not call file_tasks; just do the work.",
  "</task_planning>",
].join("\n");
const RULES = "When a task is done, call finish_task with its id; the next task will then be given to you. If a task cannot be done, call give_up_task with its id and the reason.";
const FINAL = "As a last step, run the project's full test suite (or the closest equivalent: the build and the checks the project uses) once, to make sure the changes work together and did not break each other. If something is broken, fix it. Then stop.";
// the model is never asked to check or prove anything per task
const NO_CHECKS = /verif|checked|how to tell|done when|done_when|evidence/i;
// plain workflow language: nothing about the plugin or its machinery
const PLAIN = /plugin|opencode|task.driver|\bdriver\b|state file|follow-up|nudge|automat/i;

test("normalizeTasks accepts arrays, JSON strings and {tasks}, and rejects incomplete tasks", () => {
  assert.equal(core.normalizeTasks([T(1)]).tasks.length, 1);
  assert.equal(core.normalizeTasks(JSON.stringify([T(1), T(2)])).tasks.length, 2);
  assert.equal(core.normalizeTasks({ tasks: [T(1)] }).tasks.length, 1);
  assert.deepEqual(core.normalizeTasks([{ title: "a", description: "d", done_when: "w" }]).tasks[0], { title: "a", details: "d" }, "description is read as details; other fields are dropped");
  assert.equal(core.normalizeTasks([]).error, "tasks must be a non-empty list of {title, details} objects");
  assert.equal(core.normalizeTasks("nope").error, "tasks must be a list of {title, details} objects");
  assert.match(core.normalizeTasks([{ title: "a" }]).error, /no details/);
  assert.match(core.normalizeTasks([{ details: "x" }]).error, /no title/);
  assert.match(core.normalizeTasks(Array.from({ length: core.LIMITS.tasks + 1 }, (_, i) => T(i))).error, /at most/);
  assert.equal(core.normalizeTasks([JSON.stringify(T(1)), 5]).error, "task 2 must be an object with title and details");
});

test("file_tasks files once and returns task 1 in full", () => {
  const s = core.newState("ses_x");
  assert.equal(s.mode, "tasks");
  const r = core.fileTasks(s, [T(1), T(2), { ...T(3), done_when: "dropped" }]);
  assert.equal(r.output, `Filed 3 tasks:\n1. Problem 1\n2. Problem 2\n3. Problem 3\n\nStart with task 1 of 3: Problem 1\n\n${T(1).details}\n\nWork on the tasks one at a time. ${RULES}`);
  assert.deepEqual(s.tasks.map((t) => t.status), ["open", "open", "open"]);
  assert.deepEqual(Object.keys(s.tasks[2]), ["id", "title", "details", "status", "notes", "summary", "reason", "nudges", "closed_by"]);
  assert.match(core.fileTasks(s, [T(4)]).output, /^Error: 3 tasks are already filed/);
  assert.equal(core.fileTasks(core.newState("x"), [T(1), 5]).output, "Error: task 2 must be an object with title and details");
});

test("finish_task needs no summary, keeps one if given, and hands over the next task in full", () => {
  const s = filed(3);
  const r = core.finishTask(s, 1);
  assert.equal(r.output, `Task 1 marked done.\n\nNext: task 2 of 3: Problem 2\n\n${T(2).details}\n\nWork on this task now. ${RULES}`);
  assert.equal(s.tasks[0].status, "done"); assert.equal(s.tasks[0].summary, null); assert.equal(s.tasks[0].closed_by, "model");
  assert.equal(core.currentTask(s).id, 2);
  assert.equal(core.finishTask(s, "2", "  changed the cache TTL  ").output.split("\n")[0], "Task 2 marked done.");
  assert.equal(s.tasks[1].summary, "changed the cache TTL");
  assert.match(core.finishTask(s, 2).output, /^Error: task 2 is already closed \(done\)/);
  assert.match(core.finishTask(s, 9).output, /^Error: there is no task 9/);
  // finishing a later task first leaves the current one current
  const t = filed(3);
  assert.match(core.finishTask(t, 3).output, /Next: task 1 of 3/);
  assert.equal(core.currentTask(t).id, 1);
});

test("closing the last task asks for the final pass once (in the tool result), unless disabled", () => {
  const s = filed(2);
  core.finishTask(s, 1);
  const r = core.giveUpTask(s, 2, "needs a service that is not available");
  assert.equal(s.tasks[1].status, "given_up");
  assert.equal(r.output, `Task 2 marked as given up.\n\nAll tasks are closed (1 done, 1 given up).\n${FINAL}`);
  assert.equal(s.final_pass, "tool");
  assert.equal(core.decideTasks(s), null, "no further follow-up after the final pass was asked");
  assert.match(core.giveUpTask(filed(1), 1, " ").output, /^Error: give the reason/);
  const s2 = filed(1);
  assert.equal(core.finishTask(s2, 1, "", { finalPass: false }).output, "Task 1 marked done.\n\nAll tasks are closed.");
  assert.equal(s2.final_pass, null);
});

test("task_note echoes notes and does not change the system block until the view key changes", () => {
  const s = filed(3);
  const b1 = core.systemBlock(s);
  assert.match(b1, /^<task_list>\n[\s\S]*Current task: 1 of 3: Problem 1\n\nDetails of problem 1[^\n]*\n\nNotes recorded for this task: none yet\./);
  assert.ok(b1.includes(RULES));
  const r = core.taskNote(s, 1, "the bug is in parse()");
  assert.match(r.output, /Noted for task 1 \(Problem 1\)\. Notes for this task so far:\n- the bug is in parse\(\)/);
  assert.equal(core.systemBlock(s), b1, "byte-identical within a task");
  s.compactions += 1;                                   // a compaction refreshes it
  const b2 = core.systemBlock(s);
  assert.notEqual(b2, b1);
  assert.ok(b2.includes("- the bug is in parse()"));
  core.finishTask(s, 1);
  const b3 = core.systemBlock(s);
  assert.match(b3, /Current task: 2 of 3: Problem 2/);
  assert.match(b3, /1\. \[done\] Problem 1\n2\. \[current\] Problem 2\n3\. \[open\] Problem 3/);
  assert.match(core.taskNote(s, 7, "x").output, /^Error/);
  assert.match(core.taskNote(s, 2, " ").output, /^Error: the note is empty/);
});

test("system block: planning text until tasks are filed; nothing in enforce mode; closed list at the end", () => {
  assert.equal(core.PLANNING_BLOCK, PLANNING);
  assert.equal(core.systemBlock(core.newState("ses_x")), PLANNING);
  assert.equal(core.systemBlock(core.newState("ses_x", "enforce")), null);
  const f = filed(1);
  core.finishTask(f, 1);
  assert.match(core.systemBlock(f), /All 1 tasks in this session's task list are closed:\n1\. \[done\] Problem 1/);
});

test("idle decisions: two follow-ups, then set aside and move on, then the final pass, then nothing", () => {
  const s = filed(2);
  assert.equal(core.decideTasks(core.newState("ses_y")), null, "nothing filed: inert");
  core.taskNote(s, 1, "looked at parse()");
  const n1 = core.decideTasks(s);
  assert.equal(n1.kind, "nudge"); assert.equal(n1.task, 1); assert.equal(n1.n, 1);
  assert.equal(n1.text, `Task 1 of 2 (Problem 1) is still open.\n\n${T(1).details}\n\nNotes recorded for this task:\n- looked at parse()\n\nContinue working on this task. When it is done, call finish_task; if it cannot be done, call give_up_task with the reason.`);
  assert.equal(core.decide(s).n, 2, "decide() drives tasks mode");
  const mv = core.decideTasks(s);
  assert.equal(mv.kind, "next"); assert.equal(mv.task, 2); assert.equal(mv.from, 1);
  assert.equal(mv.text, `Task 1 of 2 (Problem 1) is set aside as unfinished.\n\nNext: task 2 of 2: Problem 2\n\n${T(2).details}\n\nWork on this task now. ${RULES}`);
  assert.equal(s.tasks[0].status, "unfinished"); assert.equal(s.tasks[0].closed_by, "driver");
  core.decideTasks(s); core.decideTasks(s);              // two follow-ups for task 2
  const fin = core.decideTasks(s);
  assert.equal(fin.kind, "final");
  assert.equal(fin.text, `Task 2 of 2 (Problem 2) is set aside as unfinished.\nAll tasks are closed (0 done, 2 set aside unfinished).\n${FINAL}`);
  assert.equal(s.final_pass, "prompt");
  assert.equal(core.decideTasks(s), null);
  assert.equal(s.prompts, 6);
});

test("the follow-up cap stops everything", () => {
  const s = filed(5);
  const got = [];
  for (let i = 0; i < 20; i++) { const a = core.decideTasks(s, { maxPrompts: 4 }); if (a) got.push(a.kind); }
  assert.deepEqual(got, ["nudge", "nudge", "next", "nudge"]);
  assert.match(s.stopped, /cap reached \(4\)/);
});

test("finalPass false: no closing request", () => {
  const s = filed(1);
  core.decideTasks(s, { finalPass: false }); core.decideTasks(s, { finalPass: false });
  assert.equal(core.decideTasks(s, { finalPass: false }), null);
  assert.equal(s.tasks[0].status, "unfinished");
});

test("enforce mode follows up on open todos, at most twice per item", () => {
  const s = core.newState("ses_e", "enforce");
  assert.equal(core.decide(s), null);
  s.todos = [{ id: "a", content: "fix parser", status: "completed" }, { id: "b", content: "fix cache", status: "in_progress" }, { id: "c", content: "fix ui", status: "pending" }];
  const a1 = core.decide(s);
  assert.equal(a1.kind, "todo");
  assert.equal(a1.text, "Your todo list still has open items:\n- [in_progress] fix cache\n- [pending] fix ui\n\nContinue working on them. If an item is already done or no longer needed, update the todo list to say so.");
  assert.equal(core.decide(s).kind, "todo");
  assert.equal(core.decide(s), null, "each open item had its two follow-ups");
  s.todos.push({ id: "d", content: "new item", status: "pending" });
  assert.equal(core.decide(s).items, 1);
  s.todos.forEach((t) => { t.status = "completed"; });
  assert.equal(core.decide(s), null);
  assert.equal(s.prompts, 3);
});

test("seeUserMessage: delivered when the text matches, superseded otherwise", () => {
  const s = filed(1);
  s.pending = { id: 1, kind: "nudge", text: "Task 1 of 1 ..." };
  assert.deepEqual(core.seeUserMessage(s, "Task 1 of 1 ...\n"), { event: "delivered", kind: "nudge", id: 1 });
  assert.equal(s.pending, null); assert.equal(s.delivered, 1);
  s.pending = { id: 2, kind: "nudge", text: "x" };
  assert.equal(core.seeUserMessage(s, "something else").event, "superseded");
  assert.equal(core.seeUserMessage(s, "x"), null);
});

test("seeUserMessage: a follow-up re-sent through `opencode run` (quoted, inner quotes escaped) counts as delivered", () => {
  // opencode run 1.18.34 sends a message argument that contains a space as "<text>" with every " escaped as \"
  const s = filed(1);
  const text = 'Task 1 of 1 (Problem 1) is still open.\n\nThe page shows "Untitled".';
  s.pending = { id: 1, kind: "nudge", text };
  assert.equal(core.seeUserMessage(s, '"' + text.replace(/"/g, '\\"') + '"').event, "delivered");
  s.pending = { id: 2, kind: "nudge", text };
  assert.equal(core.seeUserMessage(s, '"' + text + ' and more"').event, "superseded");
});

test("compaction context lists every task with status, summary and notes", () => {
  const s = filed(3);
  core.taskNote(s, 2, "found it in cache.js");
  core.finishTask(s, 1, "changed the parser");
  const c = core.compactionContext(s);
  assert.match(c, /\n1\. \[done\] Problem 1 \(summary: changed the parser\)\n2\. \[current, open\] Problem 2\n   - note: found it in cache.js\n3\. \[open\] Problem 3$/);
  assert.equal(core.compactionContext(core.newState("x")), null);
  assert.equal(core.compactionContext(filed(1, "enforce")), null);
});

test("agent-visible text is plain workflow language and asks for no per-task checks", () => {
  const s = filed(2);
  const texts = [core.PLANNING_BLOCK, core.systemBlock(s), core.compactionContext(s), core.taskNote(s, 1, "n").output,
    core.listTasks(s).output, core.decideTasks(s).text, core.decideTasks(s).text, core.decideTasks(s).text,
    core.finishTask(s, 2).output, core.addTask(s, T(9)).output, core.systemBlock(s), core.compactionContext(s),
    core.fileTasks(core.newState("x"), [{ title: "a" }]).output, core.fileTasks(core.newState("x"), "nope").output];
  const e = core.newState("e", "enforce"); e.todos = [{ id: "a", content: "x", status: "pending" }];
  texts.push(core.decide(e).text);
  for (const t of texts) {
    assert.doesNotMatch(t, NO_CHECKS, t);
    assert.doesNotMatch(t, PLAIN, t);
  }
});
