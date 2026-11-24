import test from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/core.js";

const T = (n) => ({ title: `Problem ${n}`, details: `Details of problem ${n}: the "exact" error text ERR-${n}.`, done_when: `check-${n} passes` });
const filed = (n = 3, mode = "full") => { const s = core.newState("ses_x", mode); core.fileTasks(s, Array.from({ length: n }, (_, i) => T(i + 1))); return s; };

test("normalizeTasks accepts arrays, JSON strings and {tasks}, and rejects incomplete tasks", () => {
  assert.equal(core.normalizeTasks([T(1)]).tasks.length, 1);
  assert.equal(core.normalizeTasks(JSON.stringify([T(1), T(2)])).tasks.length, 2);
  assert.equal(core.normalizeTasks({ tasks: [T(1)] }).tasks.length, 1);
  assert.equal(core.normalizeTasks([{ title: "a", description: "d", doneWhen: "w" }]).tasks[0].done_when, "w");
  assert.match(core.normalizeTasks([]).error, /non-empty/);
  assert.match(core.normalizeTasks("nope").error, /list/);
  assert.match(core.normalizeTasks([{ title: "a" }]).error, /no details/);
  assert.match(core.normalizeTasks([{ details: "x" }]).error, /no title/);
  assert.match(core.normalizeTasks(Array.from({ length: core.LIMITS.tasks + 1 }, (_, i) => T(i))).error, /at most/);
  assert.match(core.normalizeTasks([JSON.stringify(T(1)), 5]).error, /task 2/);
});

test("file_tasks files once and returns task 1 in full", () => {
  const s = core.newState("ses_x");
  const r = core.fileTasks(s, [T(1), T(2), T(3)]);
  assert.equal(s.tasks.length, 3);
  assert.deepEqual(s.tasks.map((t) => t.status), ["open", "open", "open"]);
  assert.match(r.output, /Filed 3 tasks/);
  assert.match(r.output, /Start with task 1 of 3: Problem 1/);
  assert.ok(r.output.includes(T(1).details) && r.output.includes("Done when: check-1 passes"));
  assert.ok(!r.output.includes(T(2).details), "only the current task in full");
  assert.match(core.fileTasks(s, [T(4)]).output, /^Error: 3 tasks are already filed/);
});

test("finish_task needs evidence, closes the task and hands over the next one in full", () => {
  const s = filed(3);
  assert.match(core.finishTask(s, 1, "  ").output, /^Error: say how you verified/);
  assert.match(core.finishTask(s, 9, "x").output, /^Error: there is no task 9/);
  const r = core.finishTask(s, "1", "ran check-1: 4 passed");
  assert.equal(s.tasks[0].status, "done");
  assert.match(r.output, /Task 1 marked done\.\n\nNext: task 2 of 3: Problem 2/);
  assert.ok(r.output.includes(T(2).details));
  assert.equal(core.currentTask(s).id, 2);
  assert.match(core.finishTask(s, 1, "again").output, /already closed/);
  // finishing a later task first leaves the current one current
  const r3 = core.finishTask(s, 3, "ran check-3");
  assert.equal(core.currentTask(s).id, 2);
  assert.match(r3.output, /Next: task 2 of 3/);
});

test("closing the last task asks for the final pass once (in the tool result), unless disabled", () => {
  const s = filed(2);
  core.finishTask(s, 1, "ok");
  const r = core.giveUpTask(s, 2, "needs a service that is not available");
  assert.equal(s.tasks[1].status, "given_up");
  assert.match(r.output, /All tasks are closed \(1 done, 1 given up\)/);
  assert.match(r.output, /full test suite/);
  assert.equal(s.final_pass, "tool");
  assert.equal(core.decideFull(s), null, "no further follow-up after the final pass was asked");
  const s2 = filed(1);
  assert.equal(core.finishTask(s2, 1, "ok", { finalPass: false }).output, "Task 1 marked done.\n\nAll tasks are closed.");
  assert.equal(s2.final_pass, null);
});

test("task_note echoes notes and does not change the system block until the view key changes", () => {
  const s = filed(3);
  const b1 = core.systemBlock(s);
  const r = core.taskNote(s, 1, "the bug is in parse()");
  assert.match(r.output, /Noted for task 1 \(Problem 1\)\. Notes for this task so far:\n- the bug is in parse\(\)/);
  assert.equal(core.systemBlock(s), b1, "byte-identical within a task");
  s.compactions += 1;                                   // a compaction refreshes it
  const b2 = core.systemBlock(s);
  assert.notEqual(b2, b1);
  assert.ok(b2.includes("- the bug is in parse()"));
  core.finishTask(s, 1, "ok");
  const b3 = core.systemBlock(s);
  assert.match(b3, /Current task: 2 of 3: Problem 2/);
  assert.match(b3, /1\. \[done\] Problem 1\n2\. \[current\] Problem 2\n3\. \[open\] Problem 3/);
  assert.match(core.taskNote(s, 7, "x").output, /^Error/);
  assert.match(core.taskNote(s, 2, " ").output, /^Error: the note is empty/);
});

test("system block: planning text until tasks are filed; nothing in enforce mode; closed list at the end", () => {
  const s = core.newState("ses_x");
  assert.equal(core.systemBlock(s), core.PLANNING_BLOCK);
  assert.equal(core.systemBlock(core.newState("ses_x", "enforce")), null);
  const f = filed(1);
  core.finishTask(f, 1, "ok");
  assert.match(core.systemBlock(f), /All 1 tasks in this session's task list are closed:\n1\. \[done\] Problem 1/);
});

test("idle decisions: two nudges, then set aside and move on, then the final pass, then nothing", () => {
  const s = filed(2);
  assert.equal(core.decideFull(core.newState("ses_y")), null, "nothing filed: inert");
  const n1 = core.decideFull(s);
  assert.equal(n1.kind, "nudge"); assert.equal(n1.task, 1); assert.equal(n1.n, 1);
  assert.match(n1.text, /^Task 1 of 2 \(Problem 1\) is still open\./);
  assert.ok(n1.text.includes(T(1).details) && /finish_task/.test(n1.text));
  assert.equal(core.decideFull(s).n, 2);
  const mv = core.decideFull(s);
  assert.equal(mv.kind, "next"); assert.equal(mv.task, 2); assert.equal(mv.from, 1);
  assert.match(mv.text, /^Task 1 of 2 \(Problem 1\) is set aside as unfinished\.\n\nNext: task 2 of 2: Problem 2/);
  assert.equal(s.tasks[0].status, "unfinished"); assert.equal(s.tasks[0].closed_by, "driver");
  core.decideFull(s); core.decideFull(s);                // two nudges for task 2
  const fin = core.decideFull(s);
  assert.equal(fin.kind, "final");
  assert.match(fin.text, /^Task 2 of 2 \(Problem 2\) is set aside as unfinished\.\nAll tasks are closed \(0 done, 2 set aside unfinished\)\./);
  assert.equal(s.final_pass, "prompt");
  assert.equal(core.decideFull(s), null);
  assert.equal(s.prompts, 6);
});

test("the follow-up cap stops everything", () => {
  const s = filed(5);
  const got = [];
  for (let i = 0; i < 20; i++) { const a = core.decideFull(s, { maxPrompts: 4 }); if (a) got.push(a.kind); }
  assert.deepEqual(got, ["nudge", "nudge", "next", "nudge"]);
  assert.match(s.stopped, /cap reached \(4\)/);
});

test("finalPass false: no closing request", () => {
  const s = filed(1);
  core.decideFull(s, { finalPass: false }); core.decideFull(s, { finalPass: false });
  assert.equal(core.decideFull(s, { finalPass: false }), null);
  assert.equal(s.tasks[0].status, "unfinished");
});

test("enforce mode nudges on open todos, at most twice per item", () => {
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

test("compaction context lists every task with status, evidence and notes", () => {
  const s = filed(3);
  core.taskNote(s, 2, "found it in cache.js");
  core.finishTask(s, 1, "ran check-1");
  const c = core.compactionContext(s);
  assert.match(c, /1\. \[done\] Problem 1 \(verified: ran check-1\)\n2\. \[current, open\] Problem 2\n   - note: found it in cache.js\n3\. \[open\] Problem 3/);
  assert.equal(core.compactionContext(core.newState("x")), null);
  assert.equal(core.compactionContext(filed(1, "enforce")), null);
});

test("agent-visible text is plain workflow language (no talk of the plugin or its machinery)", () => {
  const s = filed(2);
  const texts = [core.PLANNING_BLOCK, core.systemBlock(s), core.compactionContext(s), core.taskNote(s, 1, "n").output,
    core.listTasks(s).output, core.decideFull(s).text, core.decideFull(s).text, core.decideFull(s).text,
    core.finishTask(s, 2, "ok").output, core.addTask(s, T(9)).output];
  const e = core.newState("e", "enforce"); e.todos = [{ id: "a", content: "x", status: "pending" }];
  texts.push(core.decide(e).text);
  for (const t of texts) assert.doesNotMatch(t, /plugin|opencode|task.driver|\bdriver\b|state file|follow-up|nudge|automat/i, t);
});
