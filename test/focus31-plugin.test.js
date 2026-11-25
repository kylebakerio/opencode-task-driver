// 0.3.1 (v3.1) through the adapter: the tool hooks feed the file map; the handoff asks for locations, not test status.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const IMPLS = { src: "../src/plugin.js", dist: "../dist/opencode-task-driver.js" };
const SID = "ses_map1";
const T = (n) => ({ title: `Problem ${n}`, details: `Details ${n}` });
const W = "/work/proj";
async function make(impl, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otd-map-"));
  delete process.env.OPENCODE_TASK_DRIVER;
  const mod = await import(IMPLS[impl]);
  const hooks = await mod.TaskDriver({ client: { session: {} }, directory: W }, { dir, delivery: "file", ...opts });
  return { hooks, dir };
}
const ctx = (m = "msg_t") => ({ sessionID: SID, messageID: m, agent: "build" });
const after = (hooks, tool, args, sid = SID) => hooks["tool.execute.after"]({ tool, sessionID: sid, callID: "c", args }, { title: "", output: "", metadata: {} });
const stateOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, SID + ".json"), "utf8"));
const events = (dir) => fs.readFileSync(path.join(dir, ".events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const HANDOFF = "Where things are and what you changed, focused and terse: the files and functions that matter for the remaining tasks, how they connect, and any gotchas. No test-status report (the task list tracks status). Write \"none\" if nothing.";

for (const impl of Object.keys(IMPLS)) {
  test(`[${impl}] 0.3.1 focus: features on by default; the handoff asks for locations, not test status`, async () => {
    const { hooks, dir } = await make(impl);
    assert.deepEqual(events(dir)[0].features, ["file-map", "test-rule", "requirements-check"]);
    assert.equal(hooks.tool.finish_task.args.handoff.description, HANDOFF);
    assert.equal(hooks.tool.give_up_task.args.handoff.description, HANDOFF);
    assert.equal(typeof hooks["tool.execute.after"], "function");
    const only = await make(impl, { fileMap: false, testRule: false });
    assert.deepEqual(events(only.dir)[0].features, ["requirements-check"]);
    const off = await make(impl, { fileMap: false, testRule: false, requirementsCheck: false });
    assert.equal(events(off.dir)[0].features, undefined);
    assert.equal(off.hooks["tool.execute.after"], undefined, "off: the 0.3.0 hook set");
    assert.match(off.hooks.tool.finish_task.args.handoff.description, /^What the remaining tasks need to know from this one, focused and terse/);
    const t = await make(impl, { mode: "tasks" });
    assert.equal(t.hooks["tool.execute.after"], undefined); assert.equal(events(t.dir)[0].features, undefined);
  });

  test(`[${impl}] reads and edits through opencode's tools land in the current task (paths relative to the workspace)`, async () => {
    const { hooks, dir } = await make(impl);
    await after(hooks, "read", { filePath: `${W}/README.md` });          // before filing: credited to task 1
    await after(hooks, "grep", { pattern: "x" });                         // a search is not a read
    await hooks.tool.file_tasks.execute({ tasks: [T(1), T(2)] }, ctx());
    await after(hooks, "read", { filePath: `${W}/src/a.js` });
    await after(hooks, "read", { filePath: "src/b.js" });                 // relative: kept as given
    await after(hooks, "read", { filePath: "/etc/hosts" });               // outside the workspace: left out
    await after(hooks, "read", { filePath: `${W}/node_modules/x/index.js` });
    await after(hooks, "edit", { filePath: `${W}/src/a.js`, oldString: "a", newString: "b" });
    await after(hooks, "write", { filePath: `${W}/src/new.js`, content: "" });
    await after(hooks, "apply_patch", { patchText: "*** Begin Patch\n*** Update File: src/c.js\n@@\n-a\n+b\n*** Add File: src/d.js\n+x\n*** End Patch" });
    let s = stateOf(dir);
    assert.deepEqual(s.tasks[0].reads, ["README.md", "src/a.js", "src/b.js"]);
    assert.deepEqual(s.tasks[0].changed, ["src/a.js", "src/new.js", "src/c.js", "src/d.js"]);
    await hooks.tool.finish_task.execute({ id: 1, handoff: "a.js: parse() at the top" }, ctx("msg_close"));
    await after(hooks, "read", { filePath: `${W}/src/a.js` });
    s = stateOf(dir);
    assert.deepEqual(s.tasks[1].reads, ["src/a.js"]);
    // a sub-agent's reads are its own business
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "ses_kid", parentID: SID } } } });
    await after(hooks, "read", { filePath: `${W}/src/z.js` }, "ses_kid");
    assert.equal(fs.existsSync(path.join(dir, "ses_kid.json")), false);
  });
}

for (const impl of Object.keys(IMPLS)) {
  test(`[${impl}] bash reads count for the file map: existing files in the workspace only, cd followed, never a throw`, async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "otd-bash-"));
    for (const f of ["top.js", "sub/a.js", "b.js", "dir/c.js", "node_modules/m/i.js"]) { fs.mkdirSync(path.dirname(path.join(ws, f)), { recursive: true }); fs.writeFileSync(path.join(ws, f), "x\n"); }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otd-map-"));
    delete process.env.OPENCODE_TASK_DRIVER;
    const mod = await import(IMPLS[impl]);
    const hooks = await mod.TaskDriver({ client: { session: {} }, directory: ws }, { dir, delivery: "file" });
    await hooks.tool.file_tasks.execute({ tasks: [T(1), T(2)] }, ctx());
    const bash = (command, extra = {}) => hooks["tool.execute.after"]({ tool: "bash", sessionID: SID, callID: "c", args: { command, description: "d", ...extra } }, { title: "", output: "", metadata: {} });
    await bash("cd sub && cat a.js missing.js ../top.js");                     // a cd holds for the rest of the command
    await bash("grep -n x dir/ b.js; cat /etc/hosts; cat node_modules/m/i.js");
    await bash(`sed -n '1,5p' ${ws}/dir/c.js`);
    await bash("cat top.js", { workdir: path.join(ws, "sub") });                   // the bash tool's workdir: sub/top.js does not exist
    for (const bad of ['echo "unterminated', "((((", "cat"]) await bash(bad);
    await hooks["tool.execute.after"]({ tool: "bash", sessionID: SID, callID: "c", args: null }, {});
    const s = stateOf(dir);
    assert.deepEqual(s.tasks[0].reads, ["sub/a.js", "top.js", "b.js", "dir/c.js"]);
    assert.ok(!events(dir).some((e) => e.event === "error"), JSON.stringify(events(dir).filter((e) => e.event === "error")));
  });
}
