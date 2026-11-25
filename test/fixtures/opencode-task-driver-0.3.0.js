// opencode-task-driver 0.3.0 -- built from src/core.js + src/plugin.js (source sha256 4690fb9c01480217). Do not edit; run `npm run build`.
// opencode-task-driver: the opencode adapter. Wires src/core.js into opencode's plugin hooks.
// See README.md for the design. Tested against opencode 1.18.34.
//
// Hooks used:
//   tool                                   file_tasks, add_task, task_note, finish_task, give_up_task, list_tasks
//                                          (focus and tasks modes; focus's finish_task / give_up_task take a handoff)
//   event                                  session.status / session.idle (follow-ups), session.error and assistant
//                                          errors (no follow-up after a failure or an abort), session.created
//                                          (sub-agent sessions are left alone), session.compacted, todo.updated
//   chat.message                           a follow-up arrived (delivered) or the user said something else
//   experimental.chat.messages.transform   marks "the next system prompt is a main-agent request"; focus mode: the
//                                          clean slate (the model's view, and the summarizer's, starts at the task)
//   experimental.chat.system.transform     the planning instructions / the task block (focus: the task context,
//                                          appended to opencode's system prompt: one system message, not two)
//   experimental.session.compacting        the task list goes into the summarizer's prompt
//   dispose                                last state write
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
const core = (() => {
// opencode-task-driver: the state machine. Pure functions over a plain JSON state object (no I/O, no opencode APIs),
// so every decision the plugin makes can be unit-tested. src/plugin.js is the opencode adapter around it.
//
// Every string in this file that starts with a capital letter and ends up in a tool result, the system prompt or a
// follow-up prompt is visible to the model. Keep it plain workflow language.

const VERSION = "0.3.0";

const DEFAULTS = Object.freeze({
  maxNudgesPerTask: 2,   // follow-up prompts for one task before it is set aside as unfinished
  maxPrompts: 24,        // hard cap on follow-up prompts the plugin sends in one session (all kinds together)
  finalPass: true,       // one closing request for a full test run once every task is closed
});

const LIMITS = Object.freeze({
  tasks: 40,             // tasks per session
  title: 200,            // characters
  details: 20000,
  note: 4000,
  notesPerTask: 50,
  summary: 4000,         // finish_task's summary, give_up_task's reason
  handoff: 20000,        // focus mode: finish_task's / give_up_task's handoff (no length rule for the model; a safety cap)
  request: 32000,        // focus mode: the original request as repeated in the task context
  files: 100,            // focus mode: changed files listed
});

// ---------------------------------------------------------------------------------------------------------------
// state

function newState(session, mode = "focus") {
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
  return s;
}

const STATUS_LABEL = { open: "open", done: "done", given_up: "given up", unfinished: "set aside: unfinished" };

// THE MODES. "tasks" drives a task list the model files: the planning block, the list outside the conversation, one
// task at a time, follow-ups, the closing full test run (0.2.0's default, kept byte-identical: test/compat.test.js).
// "focus" (the default since 0.3.0) is "tasks" plus a clean slate per task: once a task closes, the model's view of
// the conversation starts afresh at the next task, framed by a task context (the request as background, the task list
// with each closed task's summary and handoff, the files changed so far, the current task last); finish_task and
// give_up_task take a handoff for the remaining tasks. "enforce" follows the model's own todo list instead.
function drivesTasks(mode) { return mode === "tasks" || mode === "focus"; }
function focuses(state) { return state.mode === "focus"; }

function currentTask(state) {
  return state.tasks.find((t) => t.status === "open") || null;
}

function openCount(state) {
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
function normalizeTask(raw, where = "task") {
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

function normalizeTasks(raw) {
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
const TOOLS_HELP_FOCUS = "Use task_note to record findings and progress for the current task (notes are kept with the task list), add_task if you find another separate problem, and list_tasks to see the whole list.";
const workRules = (state) => (focuses(state) ? WORK_RULES_FOCUS : WORK_RULES);

const PLANNING_BLOCK = [
  "<task_planning>",
  "If the user's request contains more than one separate problem (for example several bugs, or several changes that can each be made on their own), call the file_tasks tool before you start working, with one task per problem.",
  "Write each task out completely and losslessly: put every detail from the request that matters for that problem into the task (symptoms, exact error messages and quoted text, expected behaviour, constraints, names of files, functions or features and where to look), so that the task can be done later from its own text without re-reading the request. Do not shorten or summarize details away; when unsure whether a detail matters, include it.",
  "After filing, work on the tasks one at a time, in order.",
  "If the request is a single problem, do not call file_tasks; just do the work.",
  "</task_planning>",
].join("\n");

const PLANNING_BLOCK_FOCUS = [
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
function viewKey(state) {
  const cur = currentTask(state);
  const key = [cur ? cur.id : 0, state.compactions, state.tasks.map((t) => t.status[0]).join("")];
  if (focuses(state)) key.push(state.boundary ? state.boundary.n : 0);
  return key.join(":");
}

function renderTaskBlock(state) {
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
function systemBlock(state) {
  if (!drivesTasks(state.mode)) return null;
  if (!state.tasks.length) return focuses(state) ? PLANNING_BLOCK_FOCUS : PLANNING_BLOCK;
  const key = viewKey(state);
  if (!state.view || state.view.key !== key) state.view = { key, text: focuses(state) ? renderFocusBlock(state) : renderTaskBlock(state) };
  return state.view.text;
}

function compactionContext(state) {
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
  return task;
}

// focus mode: `at` = {request, git, files} from the adapter (the session's first message, the git snapshot from when
// the work began, the changed files now); ignored in the other modes.
function fileTasks(state, rawTasks, at = {}) {
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

function addTask(state, raw) {
  if (state.tasks.length >= LIMITS.tasks) return err(`at most ${LIMITS.tasks} tasks can be filed`);
  const r = normalizeTask(raw, "task");
  if (r.error) return err(r.error);
  const t = newTask(state, state.tasks.length + 1, r.task);
  state.tasks.push(t);
  const cur = currentTask(state);
  const tail = cur && cur.id !== t.id ? ` The current task is still task ${cur.id} (${cur.title}).` : (cur ? ` It is now the current task.` : "");
  return { output: `Added task ${t.id} of ${state.tasks.length}: ${t.title}.${tail}`, event: { event: "added", id: t.id, title: t.title } };
}

function taskNote(state, id, text) {
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
function finishTask(state, id, note, opts = DEFAULTS, handoff = undefined) {
  if (!state.tasks.length) return err("no tasks are filed in this session");
  const t = taskById(state, id);
  if (!t) return err(`there is no task ${JSON.stringify(id)}; tasks are numbered 1 to ${state.tasks.length}`);
  if (t.status !== "open") return err(`task ${t.id} is already closed (${STATUS_LABEL[t.status]})`);
  if (focuses(state)) t.handoff = clipHandoff(handoff);
  else t.summary = clip(note, LIMITS.summary) || null;
  t.status = "done"; t.closed_by = "model";
  return { output: `Task ${t.id} marked done.\n\n${nextAfterClose(state, opts)}`, event: { event: "finished", id: t.id } };
}

function giveUpTask(state, id, reason, opts = DEFAULTS, handoff = undefined) {
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

function listTasks(state) {
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

function decideTasks(state, opts = DEFAULTS) {
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
function todoKey(t) { return String((t && (t.id || t.content)) || ""); }

function decideEnforce(state, opts = DEFAULTS) {
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

function decide(state, opts) {
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
function seeUserMessage(state, text) {
  if (!state.pending) return null;
  const want = String(state.pending.text || "").trim();
  const got = String(text || "").trim();
  const same = got === want || unwrapRunQuoting(got) === want;
  const p = state.pending; state.pending = null;
  if (same) { state.delivered += 1; return { event: "delivered", kind: p.kind, id: p.id }; }
  state.superseded += 1;
  return { event: "superseded", kind: p.kind, id: p.id };
}

function summary(state) {
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
function renderFocusBlock(state) {
  if (!state.tasks.length) return null;
  const cur = currentTask(state);
  const out = ["<task_context>", ...requestLines(state), ""];
  out.push(cur ? "The tasks, in order:" : "The tasks, all now closed:");
  for (const t of state.tasks) out.push(...closedTaskLines(state, t, cur));
  const files = filesLines(state.files);
  if (files.length) out.push("", ...files);
  if (cur) {
    out.push("", taskText(state, cur, "The current task is task"));
    if (!cur.notes.length) out.push("", "Notes recorded for this task: none yet.");
    out.push("", WORK_RULES_FOCUS, TOOLS_HELP_FOCUS);
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
function summarizerPrompt(state) {
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
function priorSummaryBeforeBoundary(state) {
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
function markBoundary(state, prevTaskId, by) {
  if (!focuses(state) || !state.tasks.length) return null;
  const cur = currentTask(state);
  const now = cur ? cur.id : 0;
  if (now === prevTaskId) return null;
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
function noteSummarizerView(state, view) {
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
function viewMessages(state, msgs) {
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
return { VERSION, DEFAULTS, LIMITS, newState, drivesTasks, focuses, currentTask, openCount, normalizeTask, normalizeTasks, PLANNING_BLOCK, PLANNING_BLOCK_FOCUS, viewKey, renderTaskBlock, systemBlock, compactionContext, fileTasks, addTask, taskNote, finishTask, giveUpTask, listTasks, decideTasks, todoKey, decideEnforce, decide, seeUserMessage, summary, renderFocusBlock, summarizerPrompt, priorSummaryBeforeBoundary, markBoundary, noteSummarizerView, viewMessages };
})();

const TITLE_PROMPT = "You are a title generator";   // opencode's title agent; its requests get nothing from us

function resolveMode(options) {
  const raw = String(process.env.OPENCODE_TASK_DRIVER || (options && options.mode) || "focus").trim().toLowerCase();
  if (["off", "0", "false", "no", "none"].includes(raw)) return "off";
  return raw === "focus" || raw === "tasks" || raw === "enforce" ? raw : { invalid: raw };
}

// ---- focus mode: the files changed so far, from git (read-only commands, no index lock, bounded) ----
function git(dir, args) {
  return execFileSync("git", ["--no-optional-locks", "-c", "core.quotepath=off", ...args], {
    cwd: dir, encoding: "utf8", timeout: 5000, maxBuffer: 8 << 20, stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
}
// [{s, p}]: tracked changes against `base` (committed or not) and untracked files (directories collapsed)
function gitEntries(top, base) {
  const out = [];
  const z = git(top, ["diff", "--name-status", "-M", "-z", base]).split("\0");
  for (let i = 0; i < z.length - 1;) {
    const st = z[i++];
    if (!st) continue;
    const k = st[0];
    if (k === "R" || k === "C") { const from = z[i++], to = z[i++]; out.push({ s: k, p: `${from} -> ${to}` }); }
    else out.push({ s: k, p: z[i++] });
  }
  for (const p of git(top, ["ls-files", "-z", "--others", "--exclude-standard", "--directory", "--no-empty-directory"]).split("\0")) if (p) out.push({ s: "?", p });
  return out;
}
// {top, base, start[]}: the repository, its commit and the changed files when the work began; null outside git
function gitSnapshot(dir) {
  try {
    const top = git(dir, ["rev-parse", "--show-toplevel"]).trim();
    const base = git(top, ["rev-parse", "HEAD"]).trim();
    return { top, base, start: gitEntries(top, base) };
  } catch { return null; }
}
// the files changed since the snapshot: what is changed now and was not already changed (the same way) back then
function gitFiles(snap) {
  if (!snap) return null;
  try {
    const was = new Set(snap.start.map((e) => e.s + "\0" + e.p));
    return gitEntries(snap.top, snap.base).filter((e) => !was.has(e.s + "\0" + e.p));
  } catch { return null; }
}
// the text of a user message as the model saw it (text parts, attached file contents included)
function userText(parts) {
  return (parts || []).filter((x) => x && x.type === "text" && !x.ignored && x.text).map((x) => x.text).join("\n").trim();
}

// "prompt": the plugin sends follow-ups itself (TUI, `opencode serve`, `opencode run --attach` servers).
// "file":   it only records them in the state file (`pending`) for an outside driver to send, e.g. with
//           `opencode run --session <id> "<text>"`. `opencode run` exits a few milliseconds after the session first
//           goes idle, so a prompt sent from inside it is never answered and stays in the session unanswered.
// "auto":   "file" inside `opencode run`, else "prompt".
const SUBCOMMANDS = new Set(["run", "serve", "web", "acp", "attach", "tui", "mini", "export", "import", "debug", "mcp", "github", "pr", "session", "stats"]);
function resolveDelivery(options) {
  const raw = String((options && options.delivery) || "auto").trim().toLowerCase();
  if (raw === "prompt" || raw === "file") return raw;
  const sub = process.argv.slice(2).find((a) => SUBCOMMANDS.has(a));   // the first subcommand word, past global options
  return sub === "run" ? "file" : "prompt";
}

function defaultDir() {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "opencode", "task-driver");
}

export const TaskDriver = async (input, options = {}) => {
  options = options || {};
  const dir = String(options.dir || defaultDir());
  const eventsFile = path.join(dir, ".events.jsonl");
  const log = (o) => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(eventsFile, JSON.stringify({ t: Date.now(), ...o }) + "\n");
    } catch {}
  };
  const mode = resolveMode(options);
  if (mode === "off") { log({ event: "loaded", mode: "off", version: core.VERSION }); return {}; }
  if (typeof mode === "object") { log({ event: "error", error: `unknown mode ${JSON.stringify(mode.invalid)}; expected focus, tasks, enforce or off` }); return {}; }
  const delivery = resolveDelivery(options);
  const opts = {
    maxNudgesPerTask: Number.isInteger(options.maxNudgesPerTask) ? options.maxNudgesPerTask : core.DEFAULTS.maxNudgesPerTask,
    maxPrompts: Number.isInteger(options.maxPrompts) ? options.maxPrompts : core.DEFAULTS.maxPrompts,
    finalPass: options.finalPass === undefined ? core.DEFAULTS.finalPass : Boolean(options.finalPass),
  };
  const client = input && input.client;
  log({ event: "loaded", mode, delivery, version: core.VERSION, ...opts });
  const focus = mode === "focus";
  const directory = (input && (input.directory || input.worktree)) || process.cwd();
  const gitStart = focus ? gitSnapshot(directory) : null;   // the workspace before this process's model did anything

  // ---- per-session records ----
  const recs = new Map();          // session id -> {state, busy, child, lastErr, cycleErr, agent, model}
  const mainStep = new Set();      // sessions whose next system prompt belongs to a main-agent request
  const compactingNow = new Set(); // sessions in the middle of a compaction
  const rec = (sid) => {
    let r = recs.get(sid);
    if (!r) { r = { state: undefined, busy: false, child: false, lastErr: null, cycleErr: null, agent: undefined, model: undefined, firstText: undefined }; recs.set(sid, r); }
    return r;
  };
  const fileOf = (sid) => path.join(dir, String(sid).replace(/[^A-Za-z0-9_-]/g, "_") + ".json");
  function load(sid) {
    try {
      const s = JSON.parse(fs.readFileSync(fileOf(sid), "utf8"));
      if (s && s.v === 1 && Array.isArray(s.tasks)) { s.mode = mode; return s; }
    } catch {}
    return null;
  }
  // the state if this session has one (in memory or on disk), else null
  function peek(sid) {
    const r = rec(sid);
    if (r.state === undefined) r.state = load(sid);
    return r.state;
  }
  function stateFor(sid) {
    const r = rec(sid);
    if (!peek(sid)) r.state = core.newState(sid, mode);
    return r.state;
  }
  // Synchronous on purpose: `opencode run` disposes the instance a few ms after idle, before any await returns.
  function save(sid) {
    const s = rec(sid).state;
    if (!s) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const f = fileOf(sid), tmp = f + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
      fs.renameSync(tmp, f);
    } catch (e) { log({ event: "error", session: sid, error: "save: " + String(e && e.message || e) }); }
  }
  const guard = (where, fn) => { try { return fn(); } catch (e) { log({ event: "error", where, error: String(e && e.stack || e).slice(0, 800) }); } };

  // ---- follow-ups ----
  async function send(sid, text) {
    const r = rec(sid);
    try {
      const body = { parts: [{ type: "text", text }] };
      if (r.agent) body.agent = r.agent;
      if (r.model) body.model = r.model;
      const res = await client.session.promptAsync({ path: { id: sid }, body });
      if (res && res.error) log({ event: "send-error", session: sid, error: JSON.stringify(res.error).slice(0, 500) });
      else log({ event: "sent", session: sid });
    } catch (e) { log({ event: "send-error", session: sid, error: String(e && e.message || e).slice(0, 500) }); }
  }

  function onIdle(sid, via) {
    if (!sid) return;
    const r = rec(sid);
    if (!r.busy) return;                  // the second idle event of the same cycle (session.status + session.idle)
    r.busy = false;
    if (r.child) return;                  // sub-agent sessions: never driven
    if (r.lastErr || r.cycleErr) {        // provider error, abort, ...: never turn a failure into another turn
      log({ event: "idle-skipped", session: sid, reason: r.lastErr || r.cycleErr });
      return;
    }
    const s = peek(sid);
    if (!s) return;                       // nothing filed (tasks) / no todo list seen (enforce): inert
    if (s.pending) { log({ event: "pending-dropped", session: sid, kind: s.pending.kind }); s.pending = null; }
    const before = s.stopped;
    const curBefore = focus ? (core.currentTask(s) || { id: 0 }).id : 0;
    const act = core.decide(s, opts);
    if (focus && s.tasks.length && (core.currentTask(s) || { id: 0 }).id !== curBefore) {   // the plugin moved on (set a task aside): the follow-up starts the next view; git runs only then
      const b = core.markBoundary(s, curBefore, { at: Date.now(), message: null, files: gitFiles(s.git), tool: false });
      if (b) log({ event: "boundary", session: sid, n: b.n, task: b.task, by: "followup" });
    }
    if (!act) {
      if (s.stopped && s.stopped !== before) log({ event: "stopped", session: sid, reason: s.stopped });
      save(sid);
      return;
    }
    s.pending = { id: s.prompts, kind: act.kind, task: act.task ?? null, text: act.text, at: Date.now() };
    save(sid);                            // before any await: see save()
    log({ event: "followup", session: sid, kind: act.kind, task: act.task ?? null, from: act.from ?? null, n: act.n ?? null, prompts: s.prompts, delivery, via });
    if (delivery === "prompt" && client) send(sid, act.text);
  }

  // ---- hooks ----
  const hooks = {
    event: async (arg) => guard("event", () => {
      const event = arg && arg.event;
      const p = (event && event.properties) || {};
      switch (event && event.type) {
        case "session.created":
        case "session.updated": {
          const info = p.info;
          if (info && info.id && info.parentID) rec(info.id).child = true;
          break;
        }
        case "session.status": {
          const st = p.status && p.status.type;
          if (!p.sessionID) break;
          if (st === "busy" || st === "retry") rec(p.sessionID).busy = true;
          else if (st === "idle") onIdle(p.sessionID, "session.status");
          break;
        }
        case "session.idle":
          onIdle(p.sessionID, "session.idle");
          break;
        case "session.error":
          if (p.sessionID) rec(p.sessionID).cycleErr = (p.error && p.error.name) || "error";
          break;
        case "message.updated": {
          const info = p.info;
          if (!info || info.role !== "assistant" || !info.sessionID) break;
          const r = rec(info.sessionID);
          if (info.error) r.lastErr = info.error.name || "error";
          else if (info.time && info.time.completed) { r.lastErr = null; r.cycleErr = null; }
          break;
        }
        case "session.compacted": {
          if (!p.sessionID) break;
          compactingNow.delete(p.sessionID);
          const s = peek(p.sessionID);
          if (s && s.tasks.length) {
            s.compactions += 1;
            if (focus) s.compacted_at = Date.now();
            save(p.sessionID); log({ event: "compacted", session: p.sessionID, n: s.compactions });
          }
          break;
        }
        case "todo.updated": {
          if (mode !== "enforce" || !p.sessionID || rec(p.sessionID).child) break;
          const s = stateFor(p.sessionID);
          s.todos = (Array.isArray(p.todos) ? p.todos : []).map((t) => ({ id: t.id, content: t.content, status: t.status }));
          save(p.sessionID);
          break;
        }
      }
    }),

    "chat.message": async (inp, out) => guard("chat.message", () => {
      const sid = inp && inp.sessionID;
      if (!sid) return;
      const r = rec(sid);
      if (inp.agent) r.agent = inp.agent;
      if (inp.model) r.model = inp.model;
      r.lastErr = null; r.cycleErr = null;
      const s = peek(sid);
      if (focus && !r.child && r.firstText === undefined && !s) r.firstText = userText(out && out.parts) || null;   // a candidate for the request
      if (!s || !s.pending) return;
      const text = ((out && out.parts) || []).filter((x) => x && x.type === "text" && !x.synthetic).map((x) => x.text).join("\n");
      const ev = core.seeUserMessage(s, text);
      save(sid);
      if (ev) log({ session: sid, ...ev });
    }),

    "experimental.chat.messages.transform": async (_inp, out) => guard("messages.transform", () => {
      const msgs = (out && out.messages) || [];
      const last = msgs[msgs.length - 1];
      const sid = last && last.info && last.info.sessionID;
      if (!sid) return;
      const summarizer = compactingNow.has(sid);
      if (focus && !rec(sid).child) focusView(sid, msgs, summarizer ? "summarizer" : "request");
      if (summarizer) { compactingNow.delete(sid); return; }   // the summarizer's request
      mainStep.add(sid);
    }),

    "experimental.chat.system.transform": async (inp, out) => guard("system.transform", () => {
      const sid = inp && inp.sessionID;
      if (!sid || !core.drivesTasks(mode) || !out || !Array.isArray(out.system)) return;
      if (typeof out.system[0] === "string" && out.system[0].startsWith(TITLE_PROMPT)) return;
      if (!mainStep.has(sid)) return;
      mainStep.delete(sid);
      if (rec(sid).child) return;
      const s = peek(sid) || core.newState(sid, mode);   // no tasks yet: the planning block (nothing saved)
      const key = s.view && s.view.key;
      const block = core.systemBlock(s);
      if (!block) return;
      // focus mode: INTO the system prompt, so the request keeps exactly one leading system message. opencode sends each
      // element of this array as its own system message, and some chat templates reject a second one (Qwen3.8 Flash-Next
      // on llama.cpp --jinja: "System message must be at the beginning"); opencode then retries the step without the
      // block. tasks / enforce: a separate element, as in 0.2.0.
      const last = out.system.length - 1;
      if (focus && last >= 0 && typeof out.system[last] === "string") out.system[last] = `${out.system[last]}\n\n${block}`;
      else out.system.push(block);
      if (s.tasks.length && s.view.key !== key) {
        save(sid);
        log({ event: "shown", session: sid, key: s.view.key, chars: block.length });
      }
    }),

    "experimental.session.compacting": async (inp, out) => guard("compacting", () => {
      const sid = inp && inp.sessionID;
      if (!sid) return;
      compactingNow.add(sid);
      if (!core.drivesTasks(mode)) return;
      const s = peek(sid);
      if (focus && s && core.priorSummaryBeforeBoundary(s) && out) {
        // opencode would hand the summarizer its previous summary, written before this task began, to carry forward
        out.prompt = core.summarizerPrompt(s);
        log({ event: "compaction-prompt", session: sid, tasks: s.tasks.length, reason: "previous summary predates the task" });
        return;
      }
      const ctx = s && core.compactionContext(s);
      if (ctx && out && Array.isArray(out.context)) { out.context.push(ctx); log({ event: "compaction-context", session: sid, tasks: s.tasks.length }); }
    }),

    dispose: async () => guard("dispose", () => {
      for (const [sid, r] of recs) if (r.state) save(sid);
      log({ event: "disposed" });
    }),
  };

  // focus mode: what the model (or the summarizer) sees of the conversation. opencode passes its own array and keeps
  // using that array afterwards, so it is changed in place. The stored session is never touched.
  function focusView(sid, msgs, kind) {
    const s = peek(sid);
    if (!s) {                               // nothing filed yet: remember the first request as a candidate
      const r = rec(sid);
      const first = msgs[0];
      if (r.firstText === undefined && first && first.info && first.info.role === "user" && !(first.parts || []).some((x) => x && x.type === "compaction"))
        r.firstText = userText(first.parts) || null;
      return;
    }
    const view = core.viewMessages(s, msgs);
    if (!view) return;
    if (kind === "summarizer" && core.noteSummarizerView(s, view)) {
      save(sid);
      log({ event: "hollow-compaction", session: sid, boundary: s.boundary.n });
    }
    const dropped = msgs.length - view.filter((m) => msgs.includes(m)).length;
    msgs.splice(0, msgs.length, ...view);
    const key = `${kind}:${s.boundary.n}:${dropped}`;
    if (rec(sid).viewLogged !== key) { rec(sid).viewLogged = key; log({ event: "view", session: sid, kind, boundary: s.boundary.n, dropped, kept: msgs.length }); }
  }

  // focus mode: the session's first user message, for the task context (the stored session is the authority; the
  // messages seen in this process are the fallback)
  async function firstRequest(sid) {
    try {
      if (client && client.session && client.session.messages) {
        const res = await Promise.race([client.session.messages({ path: { id: sid } }), new Promise((r) => setTimeout(() => r(null), 5000))]);
        const list = (res && (res.data || res)) || [];
        if (Array.isArray(list)) {
          const first = list.find((m) => m && m.info && m.info.role === "user" && !(m.parts || []).some((x) => x && x.type === "compaction"));
          const text = first && userText(first.parts);
          if (text) return text;
        }
      }
    } catch (e) { log({ event: "error", where: "first-request", session: sid, error: String(e && e.message || e).slice(0, 300) }); }
    return rec(sid).firstText || null;
  }

  const focusHooks = focus ? { firstRequest, gitFiles: (s) => gitFiles(s.git || gitStart), gitStart: () => gitStart } : null;
  if (core.drivesTasks(mode)) hooks.tool = tools({ stateFor, save, log, opts, focusHooks });
  return hooks;
};

// Tool argument schemas are plain JSON Schema: opencode 1.18 accepts them for plugin tools (every listed top-level
// property is required and nothing is validated, so core.js validates). No zod import keeps this a single
// dependency-free file. finish_task's summary may be empty (listed, so opencode shows it as required; core.js accepts
// it empty or missing). focus mode: finish_task takes the handoff instead of the summary (its one prose field) and
// give_up_task takes one beside the reason (shown as required; the model is asked to keep it focused and terse, with no
// length rule), and a tool call that changes the current task marks the boundary where the next task's conversation
// begins.
function tools({ stateFor, save, log, opts, focusHooks }) {
  const focus = !!focusHooks;
  const run = (ctx, fn) => {
    const sid = ctx && ctx.sessionID;
    if (!sid) return "Error: no session";
    const s = stateFor(sid);
    const curBefore = focus ? (core.currentTask(s) || { id: 0 }).id : 0;
    const filedBefore = s.tasks.length > 0;   // filing starts task 1 in the conversation it was filed in: no boundary
    let r;
    try { r = fn(s); } catch (e) { log({ event: "error", session: sid, error: String(e && e.stack || e).slice(0, 800) }); return "Error: " + String(e && e.message || e); }
    let b = null;
    if (focus && filedBefore && (core.currentTask(s) || { id: 0 }).id !== curBefore) {
      b = core.markBoundary(s, curBefore, { at: Date.now(), message: ctx.messageID || null, files: focusHooks.gitFiles(s), tool: true });
    }
    save(sid);
    if (r.event) log({ session: sid, ...r.event });
    if (b) log({ event: "boundary", session: sid, n: b.n, task: b.task, by: "tool" });
    return r.output;
  };
  const str = (description) => ({ type: "string", description });
  const id = { type: "integer", description: "The task's number in the task list." };
  const handoff = str("What the remaining tasks need to know from this one, focused and terse: files, functions or helpers you added or changed that they may use, commands that run the relevant tests, cautions. Write \"none\" if nothing.");
  const item = {
    type: "object",
    properties: {
      title: str("A short name for the problem."),
      details: str(focus
        ? "Everything from the request that matters for this problem, written out in full: symptoms, exact error messages and quoted text, expected behaviour, constraints, where to look, and which other task's change it depends on, if any."
        : "Everything from the request that matters for this problem, written out in full: symptoms, exact error messages and quoted text, expected behaviour, constraints, where to look."),
    },
    required: ["title", "details"],
  };
  const fileArgs = (args) => args && args.tasks;
  return {
    file_tasks: {
      description: focus
        ? "Split the user's request into separate tasks, one per problem, and keep them in a task list outside the conversation. Call it before starting work when the request contains more than one separate problem. Write each task completely: every detail from the request that matters for it (symptoms, exact error text and quotes, expected behaviour, constraints, where to look), so it can be done from its own text alone. List the tasks so that a task comes after any task it depends on. Returns the first task."
        : "Split the user's request into separate tasks, one per problem, and keep them in a task list outside the conversation. Call it before starting work when the request contains more than one separate problem. Write each task completely: every detail from the request that matters for it (symptoms, exact error text and quotes, expected behaviour, constraints, where to look), so it can be done from its own text alone. Returns the first task.",
      args: {
        tasks: {
          type: "array",
          description: "One entry per separate problem, in the order to work on them.",
          items: item,
        },
      },
      execute: focus
        ? async (args, ctx) => {
          const sid = ctx && ctx.sessionID;
          const known = sid ? stateFor(sid) : null;
          const at = {};
          if (known && !known.tasks.length) {     // about to file: the request and the git snapshot go with the list
            at.request = await focusHooks.firstRequest(sid);
            at.git = focusHooks.gitStart();
            at.files = focusHooks.gitFiles({ git: at.git });
          }
          return run(ctx, (s) => core.fileTasks(s, fileArgs(args), at));
        }
        : async (args, ctx) => run(ctx, (s) => core.fileTasks(s, fileArgs(args))),
    },
    add_task: {
      description: "Add one more task to the task list, for a separate problem found while working. Write it as completely as file_tasks asks.",
      args: {
        title: str("A short name for the problem."),
        details: str("Everything that matters for this problem, written out in full."),
      },
      execute: async (args, ctx) => run(ctx, (s) => core.addTask(s, args)),
    },
    task_note: {
      description: "Record a finding or a progress note for a task: what you found, what you changed, what is left. Notes are kept with the task list outside the conversation, so they are still there if the conversation is summarized.",
      args: { id, text: str("The note.") },
      execute: async (args, ctx) => run(ctx, (s) => core.taskNote(s, args && args.id, args && args.text)),
    },
    finish_task: focus
      ? {
        description: "Mark a task done. The next task then starts in a fresh conversation that shows the task list with each finished task's handoff, so put in the handoff what the remaining tasks need from this one. Returns the next task.",
        args: { id, handoff },
        execute: async (args, ctx) => run(ctx, (s) => core.finishTask(s, args && args.id, undefined, opts, args && args.handoff)),
      }
      : {
        description: "Mark a task done. Returns the next task.",
        args: { id, summary: str("Optional: a short note of what you changed. May be left empty.") },
        execute: async (args, ctx) => run(ctx, (s) => core.finishTask(s, args && args.id, args && args.summary, opts)),
      },
    give_up_task: focus
      ? {
        description: "Mark a task as one that cannot be done, with the reason and a handoff for the remaining tasks. Returns the next task.",
        args: { id, reason: str("Why it cannot be done."), handoff },
        execute: async (args, ctx) => run(ctx, (s) => core.giveUpTask(s, args && args.id, args && args.reason, opts, args && args.handoff)),
      }
      : {
        description: "Mark a task as one that cannot be done, with the reason. Returns the next task.",
        args: { id, reason: str("Why it cannot be done.") },
        execute: async (args, ctx) => run(ctx, (s) => core.giveUpTask(s, args && args.id, args && args.reason, opts)),
      },
    list_tasks: {
      description: "Show the task list with each task's status, and the current task in full.",
      args: {},
      execute: async (_args, ctx) => run(ctx, (s) => core.listTasks(s)),
    },
  };
}
