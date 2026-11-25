// `tasks` and `enforce` are what they were in 0.2.0: the same script (test/script.mjs) run against the frozen 0.2.0 build
// and against the current src and dist must record the same strings -- every system-prompt addition, tool definition,
// tool result, follow-up, compaction context and the conversation as the model sees it -- and the same state files and
// events (timestamps and the version number aside). 0.3.0 added `focus` (and made it the default) as a switch inside
// the same code; this test is what keeps the other modes still.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runScript } from "./script.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OLD = path.join(HERE, "fixtures/opencode-task-driver-0.2.0.js");
const V030 = path.join(HERE, "fixtures/opencode-task-driver-0.3.0.js");
const NEW = { src: path.join(HERE, "../src/plugin.js"), dist: path.join(HERE, "../dist/opencode-task-driver.js") };

test("the 0.2.0 fixture is the published 0.2.0 build (sha256 pinned)", () => {
  const sha = crypto.createHash("sha256").update(fs.readFileSync(OLD)).digest("hex");
  assert.equal(sha, "1d9001ff45a0cf60b87ca6b27a8d555cc2f5a5eb0c68ddddd9d0fce3f4236c3f");
});

for (const mode of ["tasks", "enforce"]) {
  for (const delivery of ["prompt", "file"]) {
    for (const [impl, file] of Object.entries(NEW)) {
      test(`[${impl}] ${mode} mode (delivery ${delivery}) records exactly what 0.2.0 recorded`, async () => {
        const old = await runScript(OLD, mode, delivery);
        const cur = await runScript(file, mode, delivery);
        assert.equal(cur.length, old.length);
        for (let i = 0; i < old.length; i++) assert.deepEqual(cur[i], old[i], `step ${i}: ${old[i][0]}`);
        // and the script did exercise the mode: follow-ups were decided, views were taken
        const sent = old.find(([k]) => k === "sent")[1];
        if (delivery === "prompt") assert.ok(sent.length >= (mode === "tasks" ? 6 : 3), `${sent.length} follow-ups`);
        const v = old.find(([k]) => k === "view: task 2")[1];
        assert.equal(v.messages.length, 3, "tasks / enforce never change the conversation");
      });
    }
  }
}

// 0.3.1 added two focus features (file map, test rule), on by default. With both off, focus is 0.3.0's exactly.
test("the 0.3.0 fixture is the 0.3.0 build (sha256 pinned)", () => {
  const sha = crypto.createHash("sha256").update(fs.readFileSync(V030)).digest("hex");
  assert.equal(sha, "19bc7959aa16e8b90d4d21bd01bae7f6eefbd12b24c35841545c69439594ec7a");
});

for (const delivery of ["prompt", "file"]) {
  for (const [impl, file] of Object.entries(NEW)) {
    test(`[${impl}] focus with fileMap and testRule off (delivery ${delivery}) records exactly what 0.3.0 recorded`, async () => {
      const old = await runScript(V030, "focus", delivery);
      const cur = await runScript(file, "focus", delivery, { fileMap: false, testRule: false, requirementsCheck: false });
      assert.equal(cur.length, old.length);
      for (let i = 0; i < old.length; i++) assert.deepEqual(cur[i], old[i], `step ${i}: ${old[i][0]}`);
      assert.match(JSON.stringify(old.find(([k]) => k === "request: task 2")[1]), /task_context/);
      // and with the features on (the default), focus does differ: the file map and the test rule show up
      const on = await runScript(file, "focus", delivery);
      const ctx4 = JSON.stringify(on.find(([k]) => k === "request: task 4")[1]);
      assert.match(ctx4, /Files the earlier tasks looked at/); assert.match(ctx4, /src\/parse\.js: 1\*/);
      assert.match(ctx4, /run only the tests for that task/);
      assert.match(JSON.stringify(on.find(([k]) => k === "finish_task 4 (last)")[1]), /re-read the original request( \(it is in the task context\))? and check each requirement and example/);
    });
  }
}
