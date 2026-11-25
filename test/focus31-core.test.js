// 0.3.1 (v3.1): focus plus a file map across the clean slate and a test-discipline line. Both are features of focus
// mode, on by default; off, focus is exactly 0.3.0's (test/compat.test.js).
import test from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/core.js";

const T = (n) => ({ title: `Problem ${n}`, details: `Details of problem ${n}.` });
const ON = { file_map: true, test_rule: true };
const focused = (n = 3, features = ON) => {
  const s = core.newState("ses_m", "focus", features);
  core.fileTasks(s, Array.from({ length: n }, (_, i) => T(i + 1)), { request: "REQ", files: [] });
  return s;
};
const TEST_RULE = "While working on a task, run only the tests for that task; the full test suite (and any build or lint step) runs once, at the end, after the last task.";

test("0.3.1: features live on the focus state only when on", () => {
  assert.deepEqual(core.newState("a", "focus", ON).features, { ...ON, requirements_check: false });
  assert.ok(!("features" in core.newState("a", "focus", { file_map: false, test_rule: false, requirements_check: false })), "off: 0.3.0's state");
  assert.ok(!("features" in core.newState("a", "focus")));
  assert.ok(!("features" in core.newState("a", "tasks", ON)), "tasks mode never has them");
});

test("the file map: reads and changes are recorded per task, and the earlier tasks' files appear in the next task's context", () => {
  const s = focused(3);
  assert.equal(core.noteFile(s, "read", "src/a.js"), true);
  core.noteFile(s, "read", "src/a.js");                               // deduplicated
  core.noteFile(s, "read", "docs/x.md");
  core.noteFile(s, "changed", "src/a.js");
  assert.deepEqual(s.tasks[0].reads, ["src/a.js", "docs/x.md"]);
  assert.deepEqual(s.tasks[0].changed, ["src/a.js"]);
  core.finishTask(s, 1, "", undefined, "none");
  // git at the boundary: what changed since the last task start is credited to the task that just closed
  core.markBoundary(s, 1, { at: 1000, message: "m", files: [{ s: "M", p: "src/a.js" }, { s: "?", p: "new/" }, { s: "R", p: "old.js -> renamed.js" }], tool: true });
  assert.deepEqual(s.tasks[0].changed, ["src/a.js", "new/", "renamed.js"]);
  const b2 = core.systemBlock(s);
  assert.ok(b2.includes("\n\nFiles the earlier tasks looked at (task numbers; * = changed in that task):\n- src/a.js: 1*\n- docs/x.md: 1\n- new/: 1*\n- renamed.js: 1*\n\nThe current task is task 2 of 3"), b2);
  core.noteFile(s, "read", "src/b.js"); core.noteFile(s, "read", "src/a.js");
  assert.equal(core.systemBlock(s), b2, "byte-stable within a task: only closed tasks are listed");
  core.finishTask(s, 2, "", undefined, "none");
  core.markBoundary(s, 2, { at: 2000, message: "m2", files: [{ s: "M", p: "src/a.js" }, { s: "?", p: "new/" }, { s: "R", p: "old.js -> renamed.js" }], tool: true });
  assert.match(core.systemBlock(s), /\n- src\/a\.js: 1\*, 2\n- docs\/x\.md: 1\n- new\/: 1\*\n- renamed\.js: 1\*\n- src\/b\.js: 2\n/);
});

test("the file map is capped; nothing recorded means no section; no current task means nothing is recorded", () => {
  const s = focused(2);
  for (let i = 0; i < 70; i++) core.noteFile(s, "read", `f${i}.js`);
  core.finishTask(s, 1, "", undefined, "none");
  core.markBoundary(s, 1, { at: 1, message: "m", files: [], tool: true });
  const b = core.systemBlock(s);
  assert.match(b, /\n- f59\.js: 1\n- \.\.\. and 10 more\n/);
  assert.doesNotMatch(b, /f60\.js/);
  const e = focused(2);
  core.finishTask(e, 1, "", undefined, "none"); core.markBoundary(e, 1, { at: 1, message: "m", files: [], tool: true });
  assert.doesNotMatch(core.systemBlock(e), /Files the earlier tasks looked at/);
  core.finishTask(e, 2, "", undefined, "none");
  assert.equal(core.noteFile(e, "read", "late.js"), false, "all closed: no task to credit");
  assert.equal(core.noteFile(focused(2, { test_rule: true }), "read", "x.js"), false, "file map off: nothing recorded");
});

test("the test-discipline line is in the task context's work rules (and only with test_rule on)", () => {
  const s = focused(2);
  const b = core.systemBlock(s);
  assert.ok(b.includes("If a task cannot be done, call give_up_task with its id, the reason and a handoff.\n" + TEST_RULE + "\nUse task_note"), b.slice(-700));
  const off = focused(2, { file_map: true });
  assert.ok(!core.systemBlock(off).includes(TEST_RULE));
  const none = core.newState("n", "focus"); core.fileTasks(none, [T(1)], { request: "REQ", files: [] });
  assert.ok(!core.systemBlock(none).includes(TEST_RULE) && !/Files the earlier tasks/.test(core.systemBlock(none)));
  // the final full-suite request is unchanged
  const f = focused(1); const r = core.finishTask(f, 1, "", undefined, "none");
  assert.match(r.output, /All tasks are closed \(1 done\)\.\nAs a last step, run the project's full test suite \(or the closest equivalent: the build and the checks the project uses\) once/);
});

// 3. requirements check (Kyle 11-24 ~15:05, in 3.1 for now): the one closing request also asks to re-read the request and
// check each stated requirement and example against the changes, then run the full suite once.
const FINAL_31 = "As a last step, re-read the original request (it is in the task context) and check each requirement and example it states against the changes made, especially the conditions that tell cases apart (for example a case that should still behave as it does now). Fix any gap you find. Then run the project's full test suite (and any build or lint step, or the closest equivalent) once, to make sure the changes work together and did not break each other. If something is broken, fix it. Then stop.";
const FINAL_30 = "As a last step, run the project's full test suite (or the closest equivalent: the build and the checks the project uses) once, to make sure the changes work together and did not break each other. If something is broken, fix it. Then stop.";
const ALL = { file_map: true, test_rule: true, requirements_check: true };

test("the final pass checks the request's requirements (v3.1), in all three places it can be asked; v3's is unchanged", () => {
  const s = core.newState("r", "focus", ALL); core.fileTasks(s, [T(1), T(2)], { request: "REQ", files: [] });
  core.finishTask(s, 1, "", undefined, "none");
  const r = core.finishTask(s, 2, "", undefined, "none");                         // in the last finish_task's result
  assert.equal(r.output, `Task 2 marked done.\n\nAll tasks are closed (2 done).\n${FINAL_31}`);
  assert.equal(core.markBoundary(s, 2, { at: 1, message: "m", tool: true }).start_text, `All tasks are closed (2 done).\n${FINAL_31}`);   // the closing view's opener
  const d = core.newState("d", "focus", ALL); core.fileTasks(d, [T(1)], { request: "REQ", files: [] });
  d.tasks[0].nudges = 2;
  const fin = core.decide(d);                                                       // as the follow-up, when the plugin set the last task aside
  assert.equal(fin.kind, "final");
  assert.equal(fin.text, `Task 1 of 1 (Problem 1) is set aside as unfinished.\nAll tasks are closed (0 done, 1 set aside unfinished).\n${FINAL_31}`);
  assert.equal(d.prompts, 1, "still one follow-up, counted as before");
  // no request captured: it is not in the task context, so the text does not say so
  const n = core.newState("n", "focus", ALL); core.fileTasks(n, [T(1)], { files: [] });
  assert.match(core.finishTask(n, 1, "", undefined, "none").output, /As a last step, re-read the original request and check each requirement/);
  // v3 (no feature) and v3.1 with the check off: 0.3.0's text
  for (const f of [undefined, { file_map: true, test_rule: true }]) {
    const v = core.newState("v", "focus", f); core.fileTasks(v, [T(1)], { request: "REQ", files: [] });
    assert.equal(core.finishTask(v, 1, "", undefined, "none").output, `Task 1 marked done.\n\nAll tasks are closed (1 done).\n${FINAL_30}`);
  }
  const t = core.newState("t", "tasks", ALL); core.fileTasks(t, [T(1)]);
  assert.equal(core.finishTask(t, 1).output, `Task 1 marked done.\n\nAll tasks are closed (1 done).\n${FINAL_30}`);
});

// 4. bash reads (11-24): in a v3 transcript of a 12-problem request bash look-ups outnumbered read-tool calls (268 vs 218), so the
// file map also takes the files a bash command reads: cat, sed -n, head, tail, nl, less, wc, and grep / rg file
// arguments. core gives the candidates (with any `cd` before them); the adapter keeps existing files in the workspace.
test("bashReadCandidates: real command shapes from the transcripts", () => {
  const c = (cmd) => core.bashReadCandidates(cmd).map((x) => (x.cwd ? `${x.cwd} :: ${x.file}` : x.file));
  assert.deepEqual(c("sed -n '120,180p' src/lib/x.js"), ["src/lib/x.js"]);
  assert.deepEqual(c("cat a.js b.js"), ["a.js", "b.js"]);
  assert.deepEqual(c("grep -n foo src/y.js"), ["src/y.js"]);
  assert.deepEqual(c("cd web-app && cat src/z.js"), ["web-app :: src/z.js"]);
  assert.deepEqual(c("cd /work/web-app && sed -n '71,92p' docs/architecture/billing.md"), ["/work/web-app :: docs/architecture/billing.md"]);
  assert.deepEqual(c('head -40 src/utils/billing.js; echo ==== ; grep -n "^import\\\\|^const.*import(" src/utils/billing.js src/utils/visits.js | head -60'),
    ["src/utils/billing.js", "src/utils/billing.js", "src/utils/visits.js"]);
  assert.deepEqual(c('grep -rn "createPlan" -B5 -A5 src/views/AccountModal.js | head -60'), ["src/views/AccountModal.js"]);
  assert.deepEqual(c('grep -n "createPlan" -A 90 src/utils/checkout.js | sed -n 1,140p'), ["src/utils/checkout.js"]);
  assert.deepEqual(c("wc -l docs/a.md docs/b.md"), ["docs/a.md", "docs/b.md"]);
  assert.deepEqual(c("cat src/utils/panel.js; npx vitest run test/flow.test.js 2>&1 | tail -30"), ["src/utils/panel.js"]);
  assert.deepEqual(c("tail -n 5 log.txt && head -c 100 data.bin && nl -ba src/a.js && less src/b.js"), ["log.txt", "data.bin", "src/a.js", "src/b.js"]);
  assert.deepEqual(c("rg -n \"flag_active\" --glob '!node_modules' -g '*.js' src/x.js"), ["src/x.js"]);
  assert.deepEqual(c('grep -rln "shared/ledger" test/ ; echo ---; ls test'), ["test/"], "a directory is a candidate; the adapter keeps files only");
  assert.deepEqual(c("grep -e foo -e bar a.js"), ["a.js"], "-e patterns: every positional is a file");
  // not reads: heredoc bodies, redirect targets, in-place edits, globs, variables, other commands
  assert.deepEqual(c("cd /w && cp src/a.js /tmp/x && python3 - <<'EOF'\nimport re\np='src/a.js'\ns=open(p).read()\nEOF"), []);
  assert.deepEqual(c("cat > notes.txt <<'EOF'\nhello\nEOF"), []);
  assert.deepEqual(c("sed -i 's/a/b/' src/a.js"), []);
  assert.deepEqual(c("cat src/*.js $F `x`"), []);
  assert.deepEqual(c("cat a.js 2>/dev/null > out.txt"), ["a.js"]);
  // never throws, whatever it is given
  for (const bad of ['echo "unterminated', "cat 'x", "((((", "", null, undefined, 42, "cd", "grep", "sed -n", "a && && b"]) {
    assert.doesNotThrow(() => core.bashReadCandidates(bad));
  }
});
