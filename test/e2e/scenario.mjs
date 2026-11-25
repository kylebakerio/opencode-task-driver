// The scripted "model" for the end-to-end test. It reads what the plugin put in the request and behaves like a
// model that follows it -- except on task 2, where it keeps stopping without finishing (to exercise the nudges).
//   planning block            -> file_tasks (3 tasks, written out in full)
//   task 1                    -> bash (fix) -> task_note (reports 9000 prompt tokens: opencode compacts) -> finish_task
//                                (with a summary)
//   task 2                    -> bash (partial) -> stops with text, every time it is asked
//   task 3 (after move-on)    -> bash (fix) -> finish_task with no summary (its result asks for the final test run)
//   all closed                -> bash (run the checks) -> final text
export const REQUEST = [
  "There are three separate problems in this project:",
  "1. config.txt: the request limit is 5 but must be 10 (the line must read `limit = 10`). Requests over 5 fail with \"429 Too Many Requests\".",
  "2. The cache never expires: entries written to cache.txt stay forever; they must expire after 60 seconds.",
  "3. page.txt must contain the line `title: Home`; without it the home page shows \"Untitled\".",
  "Please fix all three.",
].join("\n");

export const TASKS = [
  { title: "Raise the request limit in config.txt", details: "config.txt sets the request limit to 5; it must be 10, and the line must read exactly `limit = 10`. Symptom: requests over 5 fail with \"429 Too Many Requests\"." },
  { title: "Make cache entries expire", details: "Entries written to cache.txt never expire and stay forever. They must expire after 60 seconds." },
  { title: "Add the home page title", details: "page.txt must contain the line `title: Home`. Without it the home page shows \"Untitled\"." },
];

export function textOf(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (x && (x.text || "")) || "").join("\n");
  return c == null ? "" : JSON.stringify(c);
}

const call = (tool, args, extra = {}) => ({ tool, args, ...extra });
const say = (text) => ({ text });

export function decide(body, sys) {
  const msgs = body.messages || [];
  const last = msgs[msgs.length - 1] || {};
  let lastCall = null;                          // the call whose result is the last message
  if (last.role === "tool") {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === "assistant" && m.tool_calls && m.tool_calls.length) {
        const c = m.tool_calls.find((x) => x.id === last.tool_call_id) || m.tool_calls[m.tool_calls.length - 1];
        lastCall = c.function.name; break;
      }
    }
  }
  const cur = (sys.match(/Current task: (\d+) of (\d+)/) || [])[1];
  const closed = /tasks in this session's task list are closed/.test(sys);
  if (/<task_planning>/.test(sys)) return call("file_tasks", { tasks: TASKS });
  if (cur === "1") {
    if (lastCall === "file_tasks") return call("bash", { command: "printf 'limit = 10\\n' > config.txt && cat config.txt", description: "Set the request limit" });
    if (lastCall === "bash") return call("task_note", { id: 1, text: "Root cause: config.txt had limit = 5. Changed it to limit = 10; cat shows the new line." }, { ptok: 9000 });
    return call("finish_task", { id: 1, summary: "Set `limit = 10` in config.txt." });
  }
  if (cur === "2") {
    if (lastCall === "finish_task") return call("bash", { command: "printf 'ttl = ?\\n' > cache.txt", description: "Start on cache expiry" });
    return say("I started on the cache expiry but I am not sure what the right fix is, so I will stop here for now.");
  }
  if (cur === "3") {
    if (last.role === "user") return call("bash", { command: "printf 'title: Home\\n' > page.txt && cat page.txt", description: "Add the page title" });
    if (lastCall === "bash") return call("finish_task", { id: 3 });
  }
  if (closed) {
    if (lastCall === "finish_task") return call("bash", { command: "grep -q 'limit = 10' config.txt && grep -q 'title: Home' page.txt && echo ALL-CHECKS-PASS", description: "Run the checks" });
    return say("The checks pass. Tasks 1 and 3 are fixed; the cache expiry (task 2) is still open.");
  }
  return say("Nothing left to do.");
}

// enforce mode: the plugin adds no tools and no instructions; the scripted model keeps its own
// todo list with opencode's todowrite tool, fixes the first problem, and stops with two items open. The plugin's one
// follow-up ("Your todo list still has open items") gets the rest done.
//   request                   -> todowrite (3 pending)
//   todowrite #1              -> bash (fix 1)
//   bash #1                   -> todowrite (1 completed, 2 in_progress, 3 pending)
//   todowrite #2              -> stops with text
//   the follow-up             -> bash (fix 2 + 3)
//   bash #2                   -> todowrite (all completed)
//   todowrite #3              -> final text
const TODOS = ["Raise the request limit in config.txt", "Make cache entries expire", "Add the home page title"];
const todos = (...st) => ({ todos: TODOS.map((content, i) => ({ content, status: st[i], priority: "high" })) });

export function decideEnforce(body) {
  const msgs = body.messages || [];
  const last = msgs[msgs.length - 1] || {};
  const calls = [];
  for (const m of msgs) if (m.role === "assistant" && m.tool_calls) for (const c of m.tool_calls) calls.push(c.function.name);
  const n = (name) => calls.filter((c) => c === name).length;
  const lastCall = last.role === "tool" ? calls[calls.length - 1] : null;
  if (last.role === "user" && /todo list still has open items/.test(textOf(last.content))) return call("bash", { command: "printf 'ttl = 60\\n' > cache.txt && printf 'title: Home\\n' > page.txt", description: "Fix the cache and the title" });
  if (last.role === "user" && !n("todowrite")) return call("todowrite", todos("pending", "pending", "pending"));
  if (lastCall === "todowrite" && n("todowrite") === 1) return call("bash", { command: "printf 'limit = 10\\n' > config.txt", description: "Set the request limit" });
  if (lastCall === "bash" && n("bash") === 1) return call("todowrite", todos("completed", "in_progress", "pending"));
  if (lastCall === "todowrite" && n("todowrite") === 2) return say("The request limit is fixed. I will continue with the cache next time.");
  if (lastCall === "bash" && n("bash") === 2) return call("todowrite", todos("completed", "completed", "completed"));
  return say("All three problems are fixed.");
}

// focus mode (0.3.0): the same three problems, but each task after the first is worked in a fresh conversation. The
// scripted model reads the task context in the system prompt and only the messages it is shown:
//   planning block            -> file_tasks
//   task 1                    -> read config.txt (the read tool: the file map credits it to task 1) -> bash (fix)
//                                -> task_note (9000 prompt tokens: opencode compacts, still in task 1)
//                                -> finish_task with a handoff                         [boundary: task 2 starts fresh]
//   task 2, first request     -> bash (partial; 9000 prompt tokens: opencode compacts inside task 2, after the boundary)
//   task 2 afterwards         -> stops with text, every time it is asked (two follow-ups, then it is set aside)
//   task 3 (the follow-up)    -> bash (fix) -> finish_task with a handoff of "none"   [boundary: the final pass]
//   all closed                -> bash (run the checks) -> final text
export const FOCUS_HANDOFF_1 = "config.txt now reads `limit = 10`; `cat config.txt` shows it. Nothing else changed.";
// edge (decideFocus(..., { edge: true })): no compaction inside task 1; instead the step that calls finish_task(1)
// reports 9000 prompt tokens, so opencode compacts right at the boundary, before task 2's first request.
export function decideFocus(body, sys, { edge = false } = {}) {
  const msgs = (body.messages || []).filter((m) => m.role !== "system");
  const last = msgs[msgs.length - 1] || {};
  let lastCall = null;
  if (last.role === "tool") {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === "assistant" && m.tool_calls && m.tool_calls.length) { lastCall = m.tool_calls[m.tool_calls.length - 1].function.name; break; }
    }
  }
  const lastText = last.role === "user" ? textOf(last.content) : "";
  const cur = (sys.match(/The current task is task (\d+) of (\d+)/) || [])[1];
  const closed = /The tasks, all now closed:/.test(sys);
  const wd = ((sys.match(/Working directory: (\S+)/) || [])[1] || "").trim();
  if (/<task_planning>/.test(sys)) return call("file_tasks", { tasks: TASKS });
  if (cur === "1") {
    if (lastCall === "file_tasks") return call("read", { filePath: `${wd}/config.txt` });
    if (lastCall === "read") return call("bash", { command: "printf 'limit = 10\\n' > config.txt && cat config.txt", description: "Set the request limit" });
    if (lastCall === "bash") return call("task_note", { id: 1, text: "Root cause: config.txt had limit = 5. Changed it to limit = 10; cat shows the new line." }, { ptok: edge ? 1000 : 9000 });
    return call("finish_task", { id: 1, handoff: FOCUS_HANDOFF_1 }, { ptok: edge ? 9000 : 1000 });
  }
  if (cur === "2") {
    if (last.role === "user" && /^We are now on task 2 of 3/.test(lastText) && !/What did we do so far/.test(lastText)) return call("bash", { command: "printf 'ttl = ?\\n' > cache.txt", description: "Start on cache expiry" }, { ptok: edge ? 1000 : 9000 });
    if (edge && !msgs.some((m) => m.role === "assistant" && m.tool_calls)) return call("bash", { command: "printf 'ttl = ?\\n' > cache.txt", description: "Start on cache expiry" });
    return say("I started on the cache expiry but I am not sure what the right fix is, so I will stop here for now.");
  }
  if (cur === "3") {
    if (last.role === "user") return call("bash", { command: "printf 'title: Home\\n' > page.txt && cat page.txt", description: "Add the page title" });
    if (lastCall === "bash") return call("finish_task", { id: 3, handoff: "none" });
  }
  if (closed) {
    if (last.role === "user" && /^All tasks are closed/.test(lastText)) return call("bash", { command: "grep -q 'limit = 10' config.txt && grep -q 'title: Home' page.txt && echo ALL-CHECKS-PASS", description: "Run the checks" });
    return say("The checks pass. Tasks 1 and 3 are fixed; the cache expiry (task 2) is still open.");
  }
  return say("Nothing left to do.");
}
