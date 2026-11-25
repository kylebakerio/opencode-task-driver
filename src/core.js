// opencode-task-driver: the state machine. Pure functions over a plain JSON state object (no I/O, no opencode APIs),
// so every decision the plugin makes can be unit-tested. src/plugin.js is the opencode adapter around it.
//
// Every string in this file that starts with a capital letter and ends up in a tool result, the system prompt or a
// follow-up prompt is visible to the model. Keep it plain workflow language.

export const VERSION = "0.3.1";

export const DEFAULTS = Object.freeze({
  maxNudgesPerTask: 2,   // follow-up prompts for one task before it is set aside as unfinished
  maxPrompts: 24,        // hard cap on follow-up prompts the plugin sends in one session (all kinds together)
  finalPass: true,       // one closing request for a full test run once every task is closed
});

export const LIMITS = Object.freeze({
  tasks: 40,             // tasks per session
  title: 200,            // characters
  details: 20000,
  note: 4000,
  notesPerTask: 50,
  summary: 4000,         // finish_task's summary, give_up_task's reason
  handoff: 20000,        // focus mode: finish_task's / give_up_task's handoff (no length rule for the model; a safety cap)
  request: 32000,        // focus mode: the original request as repeated in the task context
  files: 100,            // focus mode: changed files listed
  mapFiles: 60,          // focus + file map (0.3.1): files listed under "Files the earlier tasks looked at"
  filesPerTask: 300,     // focus + file map: reads / changes kept per task
});

// ---------------------------------------------------------------------------------------------------------------
// state

// features (focus mode, 0.3.1): {file_map, test_rule}; kept on the state only when one is on, so with both off the state
// (and everything shown) is 0.3.0's
export function newState(session, mode = "focus", features = undefined) {
  const s = {
    v: 1,
    session,
    mode,                 // "focus" | "tasks" | "enforce"
    tasks: [],            // {id, title, details, status, notes[], summary, reason, nudges, closed_by} (+ handoff in focus)
    prompts: 0,           // follow-up prompts decided so far (each counts once, delivered or not)
    final_pass: null,     // null | "tool" (asked in a finish/give-up result) | "prompt" (asked as a follow-up prompt)
    pending: null,        // the follow-up prompt decided at the last idle and not yet seen as a user message
    delivered: 0,         // follow-up prompts that arrived as user messages
    superseded: 0,        // pending prompts replaced by a different user message
    compactions: 0,
    view: null,           // {key, text}: the task block as last rendered (kept byte-stable within a task)
    todos: [],            // enforce mode: the model's own todo list, mirrored from todo.updated events
    todo_nudges: {},      // enforce mode: todo key -> follow-ups sent while it was open
    stopped: null,        // why the plugin stopped sending follow-ups (cap reached), if it did
  };
  if (mode === "focus") Object.assign(s, {   // focus mode only (the other modes' state files stay as they were)
    request: null,        // the session's first user message, verbatim (clipped at LIMITS.request), shown as background
    git: null,            // {base, start[]}: the commit and the changed files when the work began (null: not a git repo)
    files: null,          // [{s, p}]: the changed files as of the current task's start (null: unknown)
    boundary: null,       // {n, task, at, message, start_text}: where the current task's conversation begins
    compacted_at: null,   // time of the last compaction (to tell whether opencode's previous summary predates the boundary)
  });
  setFeatures(s, features);
  return s;
}

// focus mode: set (or clear) the 0.3.1 features on a state, as the plugin's options say
export function setFeatures(state, features) {
  const f = { file_map: !!(features && features.file_map), test_rule: !!(features && features.test_rule),
              requirements_check: !!(features && features.requirements_check) };
  if (state.mode === "focus" && (f.file_map || f.test_rule || f.requirements_check)) state.features = f;
  else delete state.features;
  return state;
}
const fileMapOn = (state) => state.mode === "focus" && !!(state.features && state.features.file_map);
const testRuleOn = (state) => state.mode === "focus" && !!(state.features && state.features.test_rule);
const requirementsCheckOn = (state) => state.mode === "focus" && !!(state.features && state.features.requirements_check);

const STATUS_LABEL = { open: "open", done: "done", given_up: "given up", unfinished: "set aside: unfinished" };

// THE MODES. "tasks" drives a task list the model files: the planning block, the list outside the conversation, one
// task at a time, follow-ups, the closing full test run (0.2.0's default, kept byte-identical: test/compat.test.js).
// "focus" (the default since 0.3.0) is "tasks" plus a clean slate per task: once a task closes, the model's view of
// the conversation starts afresh at the next task, framed by a task context (the request as background, the task list
// with each closed task's summary and handoff, the files changed so far, the current task last); finish_task and
// give_up_task take a handoff for the remaining tasks. "enforce" follows the model's own todo list instead.
export function drivesTasks(mode) { return mode === "tasks" || mode === "focus"; }
export function focuses(state) { return state.mode === "focus"; }

export function currentTask(state) {
  return state.tasks.find((t) => t.status === "open") || null;
}

export function openCount(state) {
  return state.tasks.filter((t) => t.status === "open").length;
}

function taskById(state, id) {
  const n = toId(id);
  return n == null ? null : state.tasks.find((t) => t.id === n) || null;
}

function toId(id) {
  if (typeof id === "number" && Number.isInteger(id)) return id;
  if (typeof id === "string" && /^\s*#?\d+\s*$/.test(id)) return parseInt(id.replace("#", ""), 10);
  return null;
}

function clip(s, n) {
  s = String(s == null ? "" : s).trim();
  return s.length > n ? s.slice(0, n) + " [...]" : s;
}

// ---------------------------------------------------------------------------------------------------------------
// input normalization (tool arguments arrive unvalidated: local models send strings for arrays and numbers)

// A task is {title, details}; any other field the model sends is dropped.
export function normalizeTask(raw, where = "task") {
  const shape = "title and details";
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return { error: `${where} must be an object with ${shape}` }; }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: `${where} must be an object with ${shape}` };
  const title = clip(raw.title, LIMITS.title);
  const details = clip(raw.details ?? raw.description, LIMITS.details);
  if (!title) return { error: `${where} has no title` };
  if (!details) return { error: `${where} ("${title}") has no details: write out everything from the request that matters for it` };
  return { task: { title, details } };
}

export function normalizeTasks(raw) {
  const shape = "{title, details}";
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return { error: `tasks must be a list of ${shape} objects` }; }
  }
  if (raw && !Array.isArray(raw) && typeof raw === "object" && Array.isArray(raw.tasks)) raw = raw.tasks;
  if (!Array.isArray(raw) || raw.length === 0) return { error: `tasks must be a non-empty list of ${shape} objects` };
  if (raw.length > LIMITS.tasks) return { error: `at most ${LIMITS.tasks} tasks can be filed` };
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const r = normalizeTask(raw[i], `task ${i + 1}`);
    if (r.error) return { error: r.error };
    out.push(r.task);
  }
  return { tasks: out };
}

// ---------------------------------------------------------------------------------------------------------------
// rendering

// "<head> <id> of <N>: <title>" + the task's full text (details, notes)
function taskText(state, t, head = "Task", { notes = true } = {}) {
  const lines = [`${head} ${t.id} of ${state.tasks.length}: ${t.title}`, "", t.details];
  if (notes && t.notes.length) {
    lines.push("", "Notes recorded for this task:");
    for (const n of t.notes) lines.push(`- ${n.text}`);
  }
  return lines.join("\n");
}

function listLines(state, { mark = true } = {}) {
  const cur = currentTask(state);
  return state.tasks.map((t) => {
    const label = mark && cur && t.id === cur.id ? "current" : STATUS_LABEL[t.status] || t.status;
    return `${t.id}. [${label}] ${t.title}`;
  });
}

const WORK_RULES = "When a task is done, call finish_task with its id; the next task will then be given to you. If a task cannot be done, call give_up_task with its id and the reason.";
const CONTINUE = "Continue working on this task. When it is done, call finish_task; if it cannot be done, call give_up_task with the reason.";
const TOOLS_HELP = "Use task_note to record findings and progress for a task (notes are kept even if the conversation is summarized), add_task if you find another separate problem, and list_tasks to see the whole list.";
const WORK_RULES_FOCUS = "When a task is done, call finish_task with its id and a handoff: what the remaining tasks need to know from this one. The next task then starts in a fresh conversation. If a task cannot be done, call give_up_task with its id, the reason and a handoff.";
const CONTINUE_FOCUS = "Continue working on this task. When it is done, call finish_task with a handoff for the remaining tasks; if it cannot be done, call give_up_task with the reason and a handoff.";
const TEST_RULE = "While working on a task, run only the tests for that task; the full test suite (and any build or lint step) runs once, at the end, after the last task.";
const TOOLS_HELP_FOCUS = "Use task_note to record findings and progress for the current task (notes are kept with the task list), add_task if you find another separate problem, and list_tasks to see the whole list.";
const workRules = (state) => (focuses(state) ? WORK_RULES_FOCUS : WORK_RULES);

export const PLANNING_BLOCK = [
  "<task_planning>",
  "If the user's request contains more than one separate problem (for example several bugs, or several changes that can each be made on their own), call the file_tasks tool before you start working, with one task per problem.",
  "Write each task out completely and losslessly: put every detail from the request that matters for that problem into the task (symptoms, exact error messages and quoted text, expected behaviour, constraints, names of files, functions or features and where to look), so that the task can be done later from its own text without re-reading the request. Do not shorten or summarize details away; when unsure whether a detail matters, include it.",
  "After filing, work on the tasks one at a time, in order.",
  "If the request is a single problem, do not call file_tasks; just do the work.",
  "</task_planning>",
].join("\n");

export const PLANNING_BLOCK_FOCUS = [
  "<task_planning>",
  "If the user's request contains more than one separate problem (for example several bugs, or several changes that can each be made on their own), call the file_tasks tool before you start working, with one task per problem.",
  "Write each task out completely and losslessly: put every detail from the request that matters for that problem into the task (symptoms, exact error messages and quoted text, expected behaviour, constraints, names of files, functions or features and where to look), so that the task can be done later from its own text without re-reading the request. Do not shorten or summarize details away; when unsure whether a detail matters, include it.",
  "Order the tasks so that a task comes after any task it depends on. If a task depends on a change made in another task (for example a button, a function or a field that the other task adds), say so in its details.",
  "After filing, work on the tasks one at a time, in order. Each task after the first starts in a fresh conversation that shows the request, the task list with what the earlier tasks handed off, the files changed so far, and the task itself.",
  "If the request is a single problem, do not call file_tasks; just do the work.",
  "</task_planning>",
].join("\n");

// The key decides when the task block may change: a new current task, a task added, a status change, or a
// compaction. Notes added within a task do NOT change it (they are echoed in the task_note result instead), so the
// system prompt stays byte-identical across the steps of one task and a model server's prompt cache keeps its prefix.
export function viewKey(state) {
  const cur = currentTask(state);
  const key = [cur ? cur.id : 0, state.compactions, state.tasks.map((t) => t.status[0]).join("")];
  if (focuses(state)) key.push(state.boundary ? state.boundary.n : 0);
  return key.join(":");
}

export function renderTaskBlock(state) {
  if (!state.tasks.length) return null;
  const cur = currentTask(state);
  const out = ["<task_list>"];
  if (cur) {
    out.push("This session's work is split into a task list that is kept outside the conversation. Work on one task at a time; the current task is shown in full below.", "");
    out.push(taskText(state, cur, "Current task:"));
    if (!cur.notes.length) out.push("", "Notes recorded for this task: none yet.");
    out.push("", "All tasks:", ...listLines(state), "", WORK_RULES, TOOLS_HELP);
  } else {
    out.push(`All ${state.tasks.length} tasks in this session's task list are closed:`, ...listLines(state, { mark: false }));
  }
  out.push("</task_list>");
  return out.join("\n");
}

// The block for this request. tasks mode: the planning instructions until tasks are filed, then the task block,
// re-rendered only when viewKey changes. enforce mode: nothing. Mutates state.view (the caller saves it).
export function systemBlock(state) {
  if (!drivesTasks(state.mode)) return null;
  if (!state.tasks.length) return focuses(state) ? PLANNING_BLOCK_FOCUS : PLANNING_BLOCK;
  const key = viewKey(state);
  if (!state.view || state.view.key !== key) state.view = { key, text: focuses(state) ? renderFocusBlock(state) : renderTaskBlock(state) };
  return state.view.text;
}

export function compactionContext(state) {
  if (!drivesTasks(state.mode) || !state.tasks.length) return null;
  if (focuses(state)) return focusCompactionContext(state);
  const cur = currentTask(state);
  const lines = [
    "This session keeps a task list outside the conversation; it is shown to the assistant again after this summary, so the summary does not need to repeat the task texts. Keep in the summary, for each task, its number, title and status, what was found and changed for it, and what is left to do for the open ones. The task list as it stands:",
  ];
  for (const t of state.tasks) {
    let s = `${t.id}. [${cur && t.id === cur.id ? "current, open" : STATUS_LABEL[t.status]}] ${t.title}`;
    if (t.status === "done" && t.summary) s += ` (summary: ${clip(t.summary, 300)})`;
    if (t.status === "given_up" && t.reason) s += ` (reason: ${clip(t.reason, 300)})`;
    lines.push(s);
    for (const n of t.notes) lines.push(`   - note: ${clip(n.text, 500)}`);
  }
  return lines.join("\n");
}

function finalPassText(state) {
  const c = (s) => state.tasks.filter((t) => t.status === s).length;
  const parts = [`${c("done")} done`];
  if (c("given_up")) parts.push(`${c("given_up")} given up`);
  if (c("unfinished")) parts.push(`${c("unfinished")} set aside unfinished`);
  if (requirementsCheckOn(state)) {   // focus + requirements check (0.3.1): the one closing pass also checks the request
    return [
      `All tasks are closed (${parts.join(", ")}).`,
      `As a last step, re-read the original request${state.request ? " (it is in the task context)" : ""} and check each requirement and example it states against the changes made, especially the conditions that tell cases apart (for example a case that should still behave as it does now). Fix any gap you find. Then run the project's full test suite (and any build or lint step, or the closest equivalent) once, to make sure the changes work together and did not break each other. If something is broken, fix it. Then stop.`,
    ].join("\n");
  }
  return [
    `All tasks are closed (${parts.join(", ")}).`,
    "As a last step, run the project's full test suite (or the closest equivalent: the build and the checks the project uses) once, to make sure the changes work together and did not break each other. If something is broken, fix it. Then stop.",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// tools (tasks mode). Each returns {output, event}; output is the tool result the model reads.

function err(msg) { return { output: `Error: ${msg}`, event: { event: "tool-error", error: msg } }; }

function nextAfterClose(state, opts) {
  const cur = currentTask(state);
  if (cur) return `${taskText(state, cur, "Next: task")}\n\nWork on this task now. ${workRules(state)}`;
  if (state.final_pass == null && { ...DEFAULTS, ...opts }.finalPass) {
    state.final_pass = "tool";
    return finalPassText(state);
  }
  return "All tasks are closed.";
}

function newTask(state, id, t) {
  const task = { id, ...t, status: "open", notes: [], summary: null, reason: null, nudges: 0, closed_by: null };
  if (focuses(state)) task.handoff = null;
  if (fileMapOn(state)) { task.reads = []; task.changed = []; }
  return task;
}

// focus mode: `at` = {request, git, files} from the adapter (the session's first message, the git snapshot from when
// the work began, the changed files now); ignored in the other modes.
export function fileTasks(state, rawTasks, at = {}) {
  if (state.tasks.length) return err(`${state.tasks.length} tasks are already filed; use add_task to add another one, or list_tasks to see them`);
  const r = normalizeTasks(rawTasks);
  if (r.error) return err(r.error);
  state.tasks = r.tasks.map((t, i) => newTask(state, i + 1, t));
  if (focuses(state)) {
    if (at.request != null && state.request == null) state.request = clipRequest(at.request);
    if (at.git !== undefined && state.git == null) state.git = at.git;
    if (at.files !== undefined) state.files = at.files;
  }
  const cur = currentTask(state);
  const out = [
    `Filed ${state.tasks.length} task${state.tasks.length === 1 ? "" : "s"}:`,
    ...state.tasks.map((t) => `${t.id}. ${t.title}`),
    "",
    taskText(state, cur, "Start with task"),
    "",
    `Work on the tasks one at a time. ${workRules(state)}`,
  ];
  return { output: out.join("\n"), event: { event: "filed", n: state.tasks.length, titles: state.tasks.map((t) => t.title) } };
}

export function addTask(state, raw) {
  if (state.tasks.length >= LIMITS.tasks) return err(`at most ${LIMITS.tasks} tasks can be filed`);
  const r = normalizeTask(raw, "task");
  if (r.error) return err(r.error);
  const t = newTask(state, state.tasks.length + 1, r.task);
  state.tasks.push(t);
  const cur = currentTask(state);
  const tail = cur && cur.id !== t.id ? ` The current task is still task ${cur.id} (${cur.title}).` : (cur ? ` It is now the current task.` : "");
  return { output: `Added task ${t.id} of ${state.tasks.length}: ${t.title}.${tail}`, event: { event: "added", id: t.id, title: t.title } };
}

export function taskNote(state, id, text) {
  if (!state.tasks.length) return err("no tasks are filed in this session");
  const t = taskById(state, id);
  if (!t) return err(`there is no task ${JSON.stringify(id)}; tasks are numbered 1 to ${state.tasks.length}`);
  const s = clip(text, LIMITS.note);
  if (!s) return err("the note is empty");
  if (t.notes.length >= LIMITS.notesPerTask) t.notes.shift();
  t.notes.push({ text: s });
  return {
    output: [`Noted for task ${t.id} (${t.title}). Notes for this task so far:`, ...t.notes.map((n) => `- ${n.text}`)].join("\n"),
    event: { event: "noted", id: t.id, chars: s.length },
  };
}

// `note`: an optional short summary of what changed. focus mode: no summary; `handoff`, what the remaining tasks need
// from this one, is its one prose field.
export function finishTask(state, id, note, opts = DEFAULTS, handoff = undefined) {
  if (!state.tasks.length) return err("no tasks are filed in this session");
  const t = taskById(state, id);
  if (!t) return err(`there is no task ${JSON.stringify(id)}; tasks are numbered 1 to ${state.tasks.length}`);
  if (t.status !== "open") return err(`task ${t.id} is already closed (${STATUS_LABEL[t.status]})`);
  if (focuses(state)) t.handoff = clipHandoff(handoff);
  else t.summary = clip(note, LIMITS.summary) || null;
  t.status = "done"; t.closed_by = "model";
  return { output: `Task ${t.id} marked done.\n\n${nextAfterClose(state, opts)}`, event: { event: "finished", id: t.id } };
}

export function giveUpTask(state, id, reason, opts = DEFAULTS, handoff = undefined) {
  if (!state.tasks.length) return err("no tasks are filed in this session");
  const t = taskById(state, id);
  if (!t) return err(`there is no task ${JSON.stringify(id)}; tasks are numbered 1 to ${state.tasks.length}`);
  if (t.status !== "open") return err(`task ${t.id} is already closed (${STATUS_LABEL[t.status]})`);
  const r = clip(reason, LIMITS.summary);
  if (!r) return err("give the reason the task cannot be done");
  t.status = "given_up"; t.reason = r; t.closed_by = "model";
  if (focuses(state)) t.handoff = clipHandoff(handoff);
  return { output: `Task ${t.id} marked as given up.\n\n${nextAfterClose(state, opts)}`, event: { event: "gave-up", id: t.id } };
}

export function listTasks(state) {
  if (!state.tasks.length) return { output: "No tasks are filed in this session.", event: { event: "listed", n: 0 } };
  const cur = currentTask(state);
  const out = ["Tasks:", ...listLines(state)];
  if (cur) out.push("", taskText(state, cur, "Current: task"));
  return { output: out.join("\n"), event: { event: "listed", n: state.tasks.length } };
}

// ---------------------------------------------------------------------------------------------------------------
// the follow-up decision at idle. Returns {kind, text, task?} or null, and mutates the counters. The caller only
// asks when the session went idle normally (not after an error or an abort).

function capReached(state, opts) {
  if (state.prompts >= opts.maxPrompts) {
    if (!state.stopped) state.stopped = `follow-up cap reached (${opts.maxPrompts})`;
    return true;
  }
  return false;
}

export function decideTasks(state, opts = DEFAULTS) {
  opts = { ...DEFAULTS, ...opts };
  if (!state.tasks.length) return null;                               // nothing filed: single-problem behaviour
  if (state.final_pass === "prompt" && !currentTask(state)) return null;   // closing request already sent
  if (capReached(state, opts)) return null;
  let cur = currentTask(state);
  if (cur && cur.nudges < opts.maxNudgesPerTask) {
    cur.nudges += 1; state.prompts += 1;
    const text = `Task ${cur.id} of ${state.tasks.length} (${cur.title}) is still open.\n\n${cur.details}` +
      (cur.notes.length ? `\n\nNotes recorded for this task:\n${cur.notes.map((n) => `- ${n.text}`).join("\n")}` : "") +
      `\n\n${focuses(state) ? CONTINUE_FOCUS : CONTINUE}`;
    return { kind: "nudge", task: cur.id, n: cur.nudges, text };
  }
  let setAside = null;
  if (cur) {                                                           // nudges used up: set it aside, move on
    cur.status = "unfinished"; cur.closed_by = "driver"; setAside = cur;
    cur = currentTask(state);
  }
  if (cur) {
    state.prompts += 1;
    const head = `Task ${setAside.id} of ${state.tasks.length} (${setAside.title}) is set aside as unfinished.`;
    const text = `${head}\n\n${taskText(state, cur, "Next: task")}\n\nWork on this task now. ${workRules(state)}`;
    return { kind: "next", task: cur.id, from: setAside.id, text };
  }
  if (state.final_pass == null && opts.finalPass) {                     // all closed: one closing request
    state.prompts += 1; state.final_pass = "prompt";
    const head = setAside ? `Task ${setAside.id} of ${state.tasks.length} (${setAside.title}) is set aside as unfinished.\n` : "";
    return { kind: "final", from: setAside ? setAside.id : undefined, text: head + finalPassText(state) };
  }
  return null;
}

// enforce mode: the model's own todo list (todowrite). Open = pending / in_progress.
export function todoKey(t) { return String((t && (t.id || t.content)) || ""); }

export function decideEnforce(state, opts = DEFAULTS) {
  opts = { ...DEFAULTS, ...opts };
  const open = (state.todos || []).filter((t) => t && (t.status === "pending" || t.status === "in_progress"));
  if (!open.length) return null;
  const eligible = open.filter((t) => (state.todo_nudges[todoKey(t)] || 0) < opts.maxNudgesPerTask);
  if (!eligible.length) return null;
  if (capReached(state, opts)) return null;
  for (const t of eligible) state.todo_nudges[todoKey(t)] = (state.todo_nudges[todoKey(t)] || 0) + 1;
  state.prompts += 1;
  const text = ["Your todo list still has open items:", ...open.map((t) => `- [${t.status}] ${clip(t.content, 500)}`), "",
    "Continue working on them. If an item is already done or no longer needed, update the todo list to say so."].join("\n");
  return { kind: "todo", n: state.prompts, items: eligible.length, text };
}

export function decide(state, opts) {
  return state.mode === "enforce" ? decideEnforce(state, opts) : decideTasks(state, opts);
}

// `opencode run "<text>"` sends a message argument that contains a space as "<text>" with each " escaped as \"
// (opencode 1.18.34), so a follow-up re-sent that way arrives wrapped. Undo that before comparing.
function unwrapRunQuoting(s) {
  s = String(s || "").trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).replace(/\\"/g, '"').trim();
  return s;
}

// A user message arrived: the pending follow-up was delivered (same text) or superseded (anything else).
export function seeUserMessage(state, text) {
  if (!state.pending) return null;
  const want = String(state.pending.text || "").trim();
  const got = String(text || "").trim();
  const same = got === want || unwrapRunQuoting(got) === want;
  const p = state.pending; state.pending = null;
  if (same) { state.delivered += 1; return { event: "delivered", kind: p.kind, id: p.id }; }
  state.superseded += 1;
  return { event: "superseded", kind: p.kind, id: p.id };
}

export function summary(state) {
  const by = (s) => state.tasks.filter((t) => t.status === s).length;
  return {
    mode: state.mode, tasks: state.tasks.length, done: by("done"), given_up: by("given_up"), unfinished: by("unfinished"), open: by("open"),
    prompts: state.prompts, delivered: state.delivered, final_pass: state.final_pass, pending: state.pending ? state.pending.kind : null,
    stopped: state.stopped,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// focus mode (0.3.0): a clean slate per task. Everything below is used only when state.mode is "focus".

function clipRequest(text) {
  const s = unwrapRunQuoting(text);    // `opencode run "<request>"` stores the request quoted, inner quotes escaped
  if (!s) return null;
  return s.length > LIMITS.request ? s.slice(0, LIMITS.request) + "\n[... the rest of the request is cut here]" : s;
}

// The handoff has no length rule for the model (it is asked to keep it focused and terse); this is only a safety cap.
function clipHandoff(text) {
  return clip(text, LIMITS.handoff) || null;
}

const indent = (s) => String(s).replace(/\n/g, "\n   ");

const FILE_STATUS = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", T: "type changed", U: "unmerged", "?": "new, not yet added to git" };

// files: [{s, p}] from the adapter (git, compared with the start of the work), or null when unknown.
function filesLines(files) {
  if (!Array.isArray(files)) return [];
  if (!files.length) return ["Files changed so far: none."];
  const shown = files.slice(0, LIMITS.files);
  const out = ["Files changed so far (from git, compared with the start of the work):"];
  for (const f of shown) out.push(`- ${FILE_STATUS[f.s] || f.s}: ${f.p}`);
  if (files.length > shown.length) out.push(`- ... and ${files.length - shown.length} more`);
  return out;
}

function closedTaskLines(state, t, cur) {
  const label = cur && t.id === cur.id ? "current" : STATUS_LABEL[t.status] || t.status;
  const out = [`${t.id}. [${label}] ${t.title}`];
  if (t.status === "open") return out;
  if (t.summary) out.push(`   Summary: ${indent(t.summary)}`);
  if (t.reason) out.push(`   Reason: ${indent(t.reason)}`);
  if (t.handoff) out.push(`   Handoff: ${indent(t.handoff)}`);
  else if (t.status === "unfinished" && t.notes.length) {   // set aside without a handoff: its notes stand in for one
    out.push("   Notes:");
    for (const n of t.notes) out.push(`   - ${indent(n.text)}`);
  }
  return out;
}

function requestLines(state) {
  if (!state.request) return ["We received a request and broke it down into the tasks below; we are working through them one at a time."];
  return [
    "We received the request below. It is here for reference: we broke it down into the tasks listed after it and are working through them one at a time, so the parts of it outside the current task are separate tasks.",
    "",
    "<request>",
    state.request,
    "</request>",
  ];
}

// The task context: the request first (background), then the task list with what closed tasks handed off and the files
// changed so far, and the current task last, closest to the work.
export function renderFocusBlock(state) {
  if (!state.tasks.length) return null;
  const cur = currentTask(state);
  const out = ["<task_context>", ...requestLines(state), ""];
  out.push(cur ? "The tasks, in order:" : "The tasks, all now closed:");
  for (const t of state.tasks) out.push(...closedTaskLines(state, t, cur));
  const files = filesLines(state.files);
  if (files.length) out.push("", ...files);
  const map = fileMapLines(state);
  if (map.length) out.push("", ...map);
  if (cur) {
    out.push("", taskText(state, cur, "The current task is task"));
    if (!cur.notes.length) out.push("", "Notes recorded for this task: none yet.");
    out.push("", WORK_RULES_FOCUS, ...(testRuleOn(state) ? [TEST_RULE] : []), TOOLS_HELP_FOCUS);
  }
  out.push("</task_context>");
  return out.join("\n");
}

function focusCompactionContext(state) {
  const cur = currentTask(state);
  const where = cur ? `the current task (task ${cur.id} of ${state.tasks.length}: ${cur.title})` : "the closing work after every task was closed";
  const lines = [
    `This session keeps a task list outside the conversation and works each task in its own conversation; the conversation to summarize covers only ${where}. The request, the task list and what the earlier tasks handed off are shown to the assistant again after this summary, so the summary does not need to repeat them. Keep in the summary what was found and changed in this conversation and what is left to do. The task list as it stands:`,
  ];
  for (const t of state.tasks) {
    let s = `${t.id}. [${cur && t.id === cur.id ? "current, open" : STATUS_LABEL[t.status]}] ${t.title}`;
    if (t.status === "given_up" && t.reason) s += ` (reason: ${clip(t.reason, 300)})`;
    if (t.handoff) s += ` (handoff: ${clip(t.handoff, 300)})`;
    lines.push(s);
    if (cur && t.id === cur.id) for (const n of t.notes) lines.push(`   - note: ${clip(n.text, 500)}`);
  }
  return lines.join("\n");
}

// The summarizer's whole prompt, used instead of opencode's own when opencode would hand the summarizer a previous
// summary written before the current task began (it asks the summarizer to carry such a summary forward, which would
// bring the earlier tasks' conversation back into this task's view).
export function summarizerPrompt(state) {
  return [
    "Summarize the conversation below so that another coding agent can continue the work.",
    "",
    focusCompactionContext(state),
    "",
    "Write the summary in these sections, keeping every section even when it is empty (write \"(none)\"):",
    "## Goal", "## Done so far", "## In progress", "## Next steps", "## Relevant files",
    "",
    "Use short bullets. Keep exact file paths, function names, commands, error messages and identifiers. Do not mention the summary itself.",
  ].join("\n");
}

// Whether the next compaction should use summarizerPrompt(): opencode's previous summary predates the boundary.
export function priorSummaryBeforeBoundary(state) {
  return focuses(state) && !!state.boundary && state.compacted_at != null && state.compacted_at < state.boundary.at;
}

// The first message of a task's view after a boundary that a tool call made (the model closed a task itself).
function startText(state) {
  const cur = currentTask(state);
  if (cur) return `We are now on task ${cur.id} of ${state.tasks.length}: ${cur.title}. The request, the task list with what the earlier tasks handed off, the files changed so far and the full text of this task are in the task context above. Work on this task now.`;
  if (state.final_pass === "tool") return finalPassText(state);
  return "All tasks are closed.";
}

const CONTINUE_PLAIN = "Continue with the current task.";

// Call after anything that may have changed the current task (a tool, the idle decision). When it changed, the
// conversation the model sees starts afresh: state.boundary marks where. `by` = {at, message (the assistant message whose
// tool call closed the task, or null), files (the changed files now, or undefined to keep the last list), tool (true: the
// model closed it, so the view starts with startText(); false: the follow-up prompt the plugin decided is the start)}.
export function markBoundary(state, prevTaskId, by) {
  if (!focuses(state) || !state.tasks.length) return null;
  const cur = currentTask(state);
  const now = cur ? cur.id : 0;
  if (now === prevTaskId) return null;
  if (fileMapOn(state) && prevTaskId && Array.isArray(by.files)) {   // what git shows changed since the last task start
    const was = new Set((state.files || []).map((f) => f.s + "\0" + f.p));
    for (const f of by.files) if (!was.has(f.s + "\0" + f.p)) noteFileFor(state, taskById(state, prevTaskId), "changed", String(f.p).split(" -> ").pop());
  }
  if (by.files !== undefined) state.files = by.files;
  state.boundary = {
    n: (state.boundary ? state.boundary.n : 0) + 1, task: now, at: by.at, message: by.message || null,
    start_text: by.tool ? startText(state) : null,
  };
  return state.boundary;
}

// A compaction that opencode started right at a boundary (the step that closed the task still counted the old,
// full conversation) summarizes nothing of the new task: the summarizer is shown only the task's start. Its request,
// its summary and opencode's "Continue if you have next steps, or stop and ask ..." message are left out of the view, so
// the task starts as it would have without it. hollow_at (set when the summarizer's view was empty) bounds which one.
function withoutHollowCompaction(keep, b) {
  const created = (m) => (m && m.info && m.info.time && typeof m.info.time.created === "number" ? m.info.time.created : null);
  const isReq = (m) => m.info && m.info.role === "user" && (m.parts || []).some((p) => p && p.type === "compaction");
  const reqs = new Set(keep.filter((m) => isReq(m) && created(m) != null && created(m) >= b.at && created(m) <= b.hollow_at).map((m) => m.info.id));
  if (!reqs.size) return keep;
  let continueDropped = false;
  return keep.filter((m) => {
    const i = m.info || {};
    if (reqs.has(i.id)) return false;
    if (i.role === "assistant" && i.summary && reqs.has(i.parentID)) return false;
    const parts = m.parts || [];
    if (!continueDropped && i.role === "user" && parts.length && parts.every((p) => p && p.synthetic) && parts.some((p) => p && p.metadata && p.metadata.compaction_continue) && (created(m) == null || created(m) >= b.hollow_at)) {
      continueDropped = true;
      return false;
    }
    return true;
  });
}

// Called with the summarizer's view: when it holds nothing but the task's start, the compaction is hollow (see above).
export function noteSummarizerView(state, view) {
  const b = state && state.boundary;
  if (!b || !focuses(state) || !Array.isArray(view)) return false;
  const real = view.filter((m) => !(m.info && m.info.id === `msg-task-start-${b.n}`));
  if (real.length || b.hollow_at) return false;
  b.hollow_at = Date.now();
  return true;
}

// The model's view of the conversation: drops every message from before the boundary and opens with the task's start
// message. `msgs` is opencode's list (filterCompacted order: after a compaction, [compaction request, summary, kept tail,
// later messages], so position says nothing about time; creation time and the boundary message's id decide). Whole
// messages are dropped, so a tool call is never separated from its result. Returns null when nothing changes.
export function viewMessages(state, msgs) {
  const b = state && state.boundary;
  if (!b || !focuses(state) || !Array.isArray(msgs)) return null;
  const before = (m) => {
    const i = m && m.info;
    if (!i) return false;
    if (b.message && i.id === b.message) return true;
    const c = i.time && i.time.created;
    return typeof c === "number" && c < b.at;
  };
  let keep = msgs.filter((m) => !before(m));
  if (b.hollow_at) keep = withoutHollowCompaction(keep, b);
  const first = keep[0];
  if (first && first.info && (first.info.id === `msg-task-start-${b.n}` || ((first.parts || [])[0] || {}).id === `${first.info.id}-task-start`)) return keep;   // already applied
  const firstIsUser = keep.length > 0 && keep[0].info && keep[0].info.role === "user";
  const text = b.start_text || (firstIsUser ? null : CONTINUE_PLAIN);
  if (text) {
    const ref = keep[0] || msgs[msgs.length - 1] || { info: {} };
    const sid = (ref.info && ref.info.sessionID) || state.session;
    if (firstIsUser) {
      const u = keep[0];
      keep[0] = { ...u, parts: [{ id: `${u.info.id}-task-start`, sessionID: sid, messageID: u.info.id, type: "text", text: text + "\n", synthetic: true }, ...u.parts] };
    } else {
      const lastUser = [...msgs].reverse().find((m) => m.info && m.info.role === "user");
      const id = `msg-task-start-${b.n}`;
      const info = { id, sessionID: sid, role: "user", time: { created: b.at } };
      if (lastUser && lastUser.info.agent) info.agent = lastUser.info.agent;
      if (lastUser && lastUser.info.model) info.model = lastUser.info.model;
      keep.unshift({ info, parts: [{ id: `${id}-text`, sessionID: sid, messageID: id, type: "text", text, synthetic: true }] });
    }
  }
  return keep;
}


// ---------------------------------------------------------------------------------------------------------------
// focus + file map (0.3.1): what each task read and changed, so a task that starts afresh knows where the earlier ones
// looked. Fed by the adapter (opencode's read / edit / write / patch tools) and by git at each boundary.

function noteFileFor(state, t, kind, p) {
  if (!t || !fileMapOn(state)) return false;
  const list = kind === "changed" ? (t.changed = t.changed || []) : (t.reads = t.reads || []);
  const v = clip(p, 300);
  if (!v || list.includes(v)) return !!v;
  if (list.length < LIMITS.filesPerTask) list.push(v);
  return true;
}

// kind "read" | "changed", path relative to the workspace; credited to the current task. -> whether it was recorded.
export function noteFile(state, kind, p) {
  if (!fileMapOn(state)) return false;
  return noteFileFor(state, currentTask(state), kind, p);
}

// The closed tasks' files, in task order, deduplicated: "path: 1*, 3" (* = changed in that task). Only closed tasks,
// so the section is byte-stable while a task is worked.
function fileMapLines(state) {
  if (!fileMapOn(state)) return [];
  const seen = new Map();
  for (const t of state.tasks) {
    if (t.status === "open") continue;
    const changed = new Set(t.changed || []);
    for (const p of [...(t.reads || []), ...(t.changed || [])]) {
      let e = seen.get(p);
      if (!e) { e = []; seen.set(p, e); }
      const tag = `${t.id}${changed.has(p) ? "*" : ""}`;
      if (!e.some((x) => x.replace("*", "") === String(t.id))) e.push(tag);
    }
  }
  if (!seen.size) return [];
  const all = [...seen.entries()];
  const out = ["Files the earlier tasks looked at (task numbers; * = changed in that task):"];
  for (const [p, tags] of all.slice(0, LIMITS.mapFiles)) out.push(`- ${p}: ${tags.join(", ")}`);
  if (all.length > LIMITS.mapFiles) out.push(`- ... and ${all.length - LIMITS.mapFiles} more`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// focus + file map: the files a bash command reads (0.3.1). A heuristic over simple shapes -- cat, sed -n, head, tail,
// nl, less, more, wc, and the file arguments of grep / rg -- that never throws. -> [{cwd, file}] in order: `cwd` is the
// directory a `cd` earlier in the same command moved to (null: none), `file` the argument as written. The adapter
// resolves them and keeps existing files inside the workspace (so a directory given to grep drops out there).

const READERS = new Set(["cat", "sed", "head", "tail", "nl", "less", "more", "wc", "grep", "egrep", "fgrep", "rg"]);
const VALUE_OPTS = {
  head: ["-n", "-c", "--lines", "--bytes"],
  tail: ["-n", "-c", "--lines", "--bytes", "-s", "--sleep-interval", "--pid"],
  sed: ["-e", "-f", "--expression", "--file", "-l", "--line-length"],
  nl: ["-b", "-d", "-f", "-h", "-i", "-l", "-n", "-s", "-v", "-w"],
  grep: ["-e", "-f", "-A", "-B", "-C", "-m", "--regexp", "--file", "--max-count", "--context", "--after-context",
         "--before-context", "--include", "--exclude", "--exclude-dir", "--label", "-d", "-D", "--devices", "--directories"],
  rg: ["-e", "-f", "-g", "-t", "-T", "-A", "-B", "-C", "-m", "-M", "-j", "-r", "-d", "-E", "--regexp", "--file", "--glob",
       "--iglob", "--type", "--type-not", "--type-add", "--max-count", "--max-columns", "--threads", "--replace", "--max-depth",
       "--encoding", "--sort", "--sortr", "--pre", "--context", "--after-context", "--before-context", "--context-separator",
       "--path-separator", "--max-filesize"],
};
VALUE_OPTS.egrep = VALUE_OPTS.grep; VALUE_OPTS.fgrep = VALUE_OPTS.grep;

// words and operators of a command line; quotes removed. A word that came out of quotes is never an operator.
function shellTokens(src) {
  const out = []; let cur = null, i = 0;
  const flush = () => { if (cur !== null) { out.push({ t: "w", v: cur.v, q: cur.q }); cur = null; } };
  const word = () => (cur = cur || { v: "", q: false });
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'") { word().q = true; const j = src.indexOf("'", i + 1); if (j < 0) { cur.v += src.slice(i + 1); i = src.length; } else { cur.v += src.slice(i + 1, j); i = j + 1; } continue; }
    if (ch === '"') {
      word().q = true; i++;
      while (i < src.length && src[i] !== '"') { if (src[i] === "\\" && i + 1 < src.length) { cur.v += src[i + 1]; i += 2; } else cur.v += src[i++]; }
      i++; continue;
    }
    if (ch === "\\") { word().v += src[i + 1] ?? ""; i += 2; continue; }
    if (ch === " " || ch === "\t") { flush(); i++; continue; }
    if (ch === "\n" || ch === ";" || ch === "(" || ch === ")") { flush(); out.push({ t: "op", v: ch === "\n" ? ";" : ch }); i++; continue; }
    if (ch === "&" || ch === "|") {
      if (ch === "&" && src[i + 1] === ">") { flush(); out.push({ t: "redir", v: "&>" }); i += src[i + 2] === ">" ? 3 : 2; continue; }
      flush(); const two = src[i + 1] === ch; out.push({ t: "op", v: two ? ch + ch : ch }); i += two ? 2 : 1; continue;
    }
    if (ch === ">" || ch === "<") {
      if (cur && /^\d+$/.test(cur.v) && !cur.q) cur = null; else flush();   // 2>... : the fd number is part of the redirect
      let op = ch; i++;
      while (i < src.length && (src[i] === ">" || src[i] === "<")) op += src[i++];
      if (src[i] === "&") { i++; while (i < src.length && /[\d-]/.test(src[i])) i++; continue; }   // 2>&1: no target
      if (src[i] === "-" && op === "<<") { op += "-"; i++; }
      out.push({ t: "redir", v: op }); continue;
    }
    word().v += ch; i++;
  }
  flush();
  return out;
}

// heredoc bodies are data, not commands: drop every line from a `<<WORD` line up to the WORD line
function dropHeredocs(src) {
  const lines = String(src).split("\n"), out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const m = lines[i].match(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/);
    if (m && !/<<</.test(lines[i])) { const end = m[2]; while (i + 1 < lines.length && lines[i + 1].trim() !== end) i++; i++; }
  }
  return out.join("\n");
}

const PLAIN_PATH = (w) => !!w && !/[*?[\]{}$`~]/.test(w) && w !== "-" && w !== "/dev/null" && !w.startsWith("/dev/") && !w.startsWith("/proc/");

function readerFiles(cmd, words) {
  const valueOpts = VALUE_OPTS[cmd] || [];
  const files = [], positionals = [];
  let explicitPattern = false, inplace = false, endOpts = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!endOpts && w === "--") { endOpts = true; continue; }
    if (!endOpts && w.length > 1 && w.startsWith("-") && !/^-\d+$/.test(w) || (!endOpts && cmd === "head" && /^-\d+$/.test(w)) || (!endOpts && cmd === "tail" && /^[-+]\d+$/.test(w))) {
      const name = w.startsWith("--") ? w.split("=")[0] : w.slice(0, 2);
      if (cmd === "sed" && (name === "-i" || name === "--in-place" || /^-[a-zA-Z]*i/.test(w) && !w.startsWith("--"))) inplace = true;
      if (["-e", "-f", "--regexp", "--file", "--expression"].includes(name) && (cmd === "sed" || VALUE_OPTS.grep.includes(name) || cmd === "rg")) explicitPattern = true;
      if (valueOpts.includes(w)) i++;                              // the option's value is the next word (-A 90, -n 40, -g '*.js')
      continue;
    }
    if (!endOpts && cmd === "less" && w.startsWith("+")) continue;
    positionals.push(w);
  }
  if (cmd === "sed" && inplace) return [];
  const skip = (cmd === "sed" || cmd === "grep" || cmd === "egrep" || cmd === "fgrep" || cmd === "rg") && !explicitPattern ? 1 : 0;   // the script / pattern
  for (const w of positionals.slice(skip)) if (PLAIN_PATH(w)) files.push(w);
  return files;
}

export function bashReadCandidates(command) {
  try {
    if (typeof command !== "string" || !command.trim()) return [];
    const toks = shellTokens(dropHeredocs(command));
    const out = [];
    let cwd = null, seg = [], skipNext = false;
    const end = () => {
      const words = seg; seg = [];
      let k = 0;
      while (k < words.length && (/^[A-Za-z_]\w*=/.test(words[k]) || ["sudo", "time", "command", "nice", "env", "exec"].includes(words[k]))) k++;
      const cmd = words[k] && words[k].split("/").pop();
      if (!cmd) return;
      if (cmd === "cd") { const d = words[k + 1]; if (d && PLAIN_PATH(d)) cwd = d.startsWith("/") || !cwd ? d : `${cwd}/${d}`; return; }
      if (!READERS.has(cmd)) return;
      for (const file of readerFiles(cmd, words.slice(k + 1))) { if (out.length < 50) out.push({ cwd, file }); }
    };
    for (const t of toks) {
      if (t.t === "op") { end(); skipNext = false; continue; }
      if (t.t === "redir") { skipNext = true; continue; }
      if (skipNext) { skipNext = false; continue; }           // a redirect's target is written or fed, not read as an argument
      seg.push(t.v);
    }
    end();
    return out;
  } catch { return []; }
}
