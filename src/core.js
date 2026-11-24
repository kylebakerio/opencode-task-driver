// opencode-task-driver: the state machine. Pure functions over a plain JSON state object (no I/O, no opencode APIs),
// so every decision the plugin makes can be unit-tested. src/plugin.js is the opencode adapter around it.
//
// Every string in this file that starts with a capital letter and ends up in a tool result, the system prompt or a
// follow-up prompt is visible to the model. Keep it plain workflow language.

export const VERSION = "0.1.0";

export const DEFAULTS = Object.freeze({
  maxNudgesPerTask: 2,   // follow-up prompts for one task before it is set aside as unfinished
  maxPrompts: 24,        // hard cap on follow-up prompts the plugin sends in one session (all kinds together)
  finalPass: true,       // one closing request for a full test run once every task is closed
});

export const LIMITS = Object.freeze({
  tasks: 40,             // tasks per session
  title: 200,            // characters
  details: 20000,
  doneWhen: 4000,
  note: 4000,
  notesPerTask: 50,
  evidence: 4000,
});

// ---------------------------------------------------------------------------------------------------------------
// state

export function newState(session, mode = "full") {
  return {
    v: 1,
    session,
    mode,                 // "full" | "enforce"
    tasks: [],            // {id, title, details, done_when, status, notes[], evidence, reason, nudges, closed_by}
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
}

const STATUS_LABEL = { open: "open", done: "done", given_up: "given up", unfinished: "set aside: unfinished" };

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

export function normalizeTask(raw, where = "task") {
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return { error: `${where} must be an object with title, details and done_when` }; }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: `${where} must be an object with title, details and done_when` };
  const title = clip(raw.title, LIMITS.title);
  const details = clip(raw.details ?? raw.description, LIMITS.details);
  const done_when = clip(raw.done_when ?? raw.doneWhen ?? raw.done, LIMITS.doneWhen);
  if (!title) return { error: `${where} has no title` };
  if (!details) return { error: `${where} ("${title}") has no details: write out everything from the request that matters for it` };
  return { task: { title, details, done_when } };
}

export function normalizeTasks(raw) {
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return { error: "tasks must be a list of {title, details, done_when} objects" }; }
  }
  if (raw && !Array.isArray(raw) && typeof raw === "object" && Array.isArray(raw.tasks)) raw = raw.tasks;
  if (!Array.isArray(raw) || raw.length === 0) return { error: "tasks must be a non-empty list of {title, details, done_when} objects" };
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

// "<head> <id> of <N>: <title>" + the task's full text (details, done when, notes)
function taskText(state, t, head = "Task", { notes = true } = {}) {
  const lines = [`${head} ${t.id} of ${state.tasks.length}: ${t.title}`, "", t.details];
  if (t.done_when) lines.push("", `Done when: ${t.done_when}`);
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

const WORK_RULES = "When a task is done and you have checked it, call finish_task with its id and how you verified it; the next task will then be given to you. If a task cannot be done, call give_up_task with its id and the reason.";
const TOOLS_HELP = "Use task_note to record findings and progress for a task (notes are kept even if the conversation is summarized), add_task if you find another separate problem, and list_tasks to see the whole list.";

export const PLANNING_BLOCK = [
  "<task_planning>",
  "If the user's request contains more than one separate problem (for example several bugs, or several changes that can each be made and checked on their own), call the file_tasks tool before you start working, with one task per problem.",
  "Write each task out completely and losslessly: put every detail from the request that matters for that problem into the task (symptoms, exact error messages and quoted text, expected behaviour, constraints, names of files, functions or features and where to look, and how to tell it is done), so that the task can be done later from its own text without re-reading the request. Do not shorten or summarize details away; when unsure whether a detail matters, include it.",
  "After filing, work on the tasks one at a time, in order.",
  "If the request is a single problem, do not call file_tasks; just do the work.",
  "</task_planning>",
].join("\n");

// The key decides when the task block may change: a new current task, a task added, a status change, or a
// compaction. Notes added within a task do NOT change it (they are echoed in the task_note result instead), so the
// system prompt stays byte-identical across the steps of one task and a model server's prompt cache keeps its prefix.
export function viewKey(state) {
  const cur = currentTask(state);
  return [cur ? cur.id : 0, state.compactions, state.tasks.map((t) => t.status[0]).join("")].join(":");
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

// The block for this request. full mode: the planning instructions until tasks are filed, then the task block,
// re-rendered only when viewKey changes. enforce mode: nothing. Mutates state.view (the caller saves it).
export function systemBlock(state) {
  if (state.mode !== "full") return null;
  if (!state.tasks.length) return PLANNING_BLOCK;
  const key = viewKey(state);
  if (!state.view || state.view.key !== key) state.view = { key, text: renderTaskBlock(state) };
  return state.view.text;
}

export function compactionContext(state) {
  if (state.mode !== "full" || !state.tasks.length) return null;
  const cur = currentTask(state);
  const lines = [
    "This session keeps a task list outside the conversation; it is shown to the assistant again after this summary, so the summary does not need to repeat the task texts. Keep in the summary, for each task, its number, title and status, what was found and changed for it, and what is left to do for the open ones. The task list as it stands:",
  ];
  for (const t of state.tasks) {
    let s = `${t.id}. [${cur && t.id === cur.id ? "current, open" : STATUS_LABEL[t.status]}] ${t.title}`;
    if (t.status === "done" && t.evidence) s += ` (verified: ${clip(t.evidence, 300)})`;
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
  return [
    `All tasks are closed (${parts.join(", ")}).`,
    "As a last step, run the project's full test suite (or the closest equivalent: the build and the checks the project uses) once, to make sure the changes work together and did not break each other. If something is broken, fix it. Then stop.",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// tools (full mode). Each returns {output, event}; output is the tool result the model reads.

function err(msg) { return { output: `Error: ${msg}`, event: { event: "tool-error", error: msg } }; }

function nextAfterClose(state, opts) {
  const cur = currentTask(state);
  if (cur) return `${taskText(state, cur, "Next: task")}\n\nWork on this task now. ${WORK_RULES}`;
  if (state.final_pass == null && { ...DEFAULTS, ...opts }.finalPass) {
    state.final_pass = "tool";
    return finalPassText(state);
  }
  return "All tasks are closed.";
}

export function fileTasks(state, rawTasks) {
  if (state.tasks.length) return err(`${state.tasks.length} tasks are already filed; use add_task to add another one, or list_tasks to see them`);
  const r = normalizeTasks(rawTasks);
  if (r.error) return err(r.error);
  state.tasks = r.tasks.map((t, i) => ({ id: i + 1, ...t, status: "open", notes: [], evidence: null, reason: null, nudges: 0, closed_by: null }));
  const cur = currentTask(state);
  const out = [
    `Filed ${state.tasks.length} task${state.tasks.length === 1 ? "" : "s"}:`,
    ...state.tasks.map((t) => `${t.id}. ${t.title}`),
    "",
    taskText(state, cur, "Start with task"),
    "",
    `Work on the tasks one at a time. ${WORK_RULES}`,
  ];
  return { output: out.join("\n"), event: { event: "filed", n: state.tasks.length, titles: state.tasks.map((t) => t.title) } };
}

export function addTask(state, raw) {
  if (state.tasks.length >= LIMITS.tasks) return err(`at most ${LIMITS.tasks} tasks can be filed`);
  const r = normalizeTask(raw);
  if (r.error) return err(r.error);
  const t = { id: state.tasks.length + 1, ...r.task, status: "open", notes: [], evidence: null, reason: null, nudges: 0, closed_by: null };
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

export function finishTask(state, id, evidence, opts = DEFAULTS) {
  if (!state.tasks.length) return err("no tasks are filed in this session");
  const t = taskById(state, id);
  if (!t) return err(`there is no task ${JSON.stringify(id)}; tasks are numbered 1 to ${state.tasks.length}`);
  if (t.status !== "open") return err(`task ${t.id} is already closed (${STATUS_LABEL[t.status]})`);
  const ev = clip(evidence, LIMITS.evidence);
  if (!ev) return err("say how you verified that the task is done (for example which test or command you ran and what it showed)");
  t.status = "done"; t.evidence = ev; t.closed_by = "model";
  return { output: `Task ${t.id} marked done.\n\n${nextAfterClose(state, opts)}`, event: { event: "finished", id: t.id } };
}

export function giveUpTask(state, id, reason, opts = DEFAULTS) {
  if (!state.tasks.length) return err("no tasks are filed in this session");
  const t = taskById(state, id);
  if (!t) return err(`there is no task ${JSON.stringify(id)}; tasks are numbered 1 to ${state.tasks.length}`);
  if (t.status !== "open") return err(`task ${t.id} is already closed (${STATUS_LABEL[t.status]})`);
  const r = clip(reason, LIMITS.evidence);
  if (!r) return err("give the reason the task cannot be done");
  t.status = "given_up"; t.reason = r; t.closed_by = "model";
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

export function decideFull(state, opts = DEFAULTS) {
  opts = { ...DEFAULTS, ...opts };
  if (!state.tasks.length) return null;                               // nothing filed: single-problem behaviour
  if (state.final_pass === "prompt" && !currentTask(state)) return null;   // closing request already sent
  if (capReached(state, opts)) return null;
  let cur = currentTask(state);
  if (cur && cur.nudges < opts.maxNudgesPerTask) {
    cur.nudges += 1; state.prompts += 1;
    const text = `Task ${cur.id} of ${state.tasks.length} (${cur.title}) is still open.\n\n${cur.details}` +
      (cur.done_when ? `\n\nDone when: ${cur.done_when}` : "") +
      (cur.notes.length ? `\n\nNotes recorded for this task:\n${cur.notes.map((n) => `- ${n.text}`).join("\n")}` : "") +
      `\n\nContinue working on this task. When it is done and checked, call finish_task with how you verified it; if it cannot be done, call give_up_task with the reason.`;
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
    const text = `${head}\n\n${taskText(state, cur, "Next: task")}\n\nWork on this task now. ${WORK_RULES}`;
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
  return state.mode === "enforce" ? decideEnforce(state, opts) : decideFull(state, opts);
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
