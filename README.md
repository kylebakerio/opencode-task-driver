# opencode-task-driver

An [opencode](https://opencode.ai) plugin for requests that hold several separate problems ("there are three bugs:
..."). It has the agent split the request into a task list, keeps that list outside the conversation, and works the
tasks one at a time: the current task is shown in full on every step, a follow-up goes out when the agent stops with a
task still open, and one full test run closes the session.

A request with a single problem is left alone: no tools are called and no follow-ups are sent.

- One JavaScript file, no dependencies.
- Modes: `tasks` (default), `enforce` and `off`. See [Modes](#modes).
- Tested with opencode 1.18.34 on Linux. See [Compatibility](#compatibility).

## Quick start

```sh
git clone https://github.com/kylebakerio/opencode-task-driver
mkdir -p ~/.config/opencode/plugin
cp opencode-task-driver/dist/opencode-task-driver.js ~/.config/opencode/plugin/
```

Start opencode as usual; the plugin runs in `tasks` mode. To choose a mode, set `OPENCODE_TASK_DRIVER=enforce` (or
`tasks`, `off`) in opencode's environment, or load the plugin from `opencode.json` with options (see
[Install](#install)).

## Why

Given one request that bundles several separate bugs or changes, a coding agent often fixes some of them and stops, or
never reads the code behind the others. The plugin turns a multi-problem request into a sequence of single-problem
steps, without changing what the user types: each task is written out in full from the request, handed to the agent on
its own, and followed up until it is finished, given up, or set aside.

## Modes

| mode | what the agent gets | use it when |
|---|---|---|
| `tasks` (default) | the planning instructions, six task tools, the current task in the system prompt, follow-ups, a final test run | the requests you give the agent often hold several separate problems |
| `enforce` | no instructions and no tools. The plugin follows opencode's built-in todo list (`todowrite`): if the agent stops with todo items still `pending` or `in_progress`, a follow-up asks it to continue them | you only want "do not stop with open todo items", and nothing added to the prompt |
| `off` | the plugin loads and does nothing | |

Set the mode with the environment variable `OPENCODE_TASK_DRIVER` (it wins) or the `mode` option. An unknown value
disables the plugin and writes an `error` line to the event log.

## Install

The plugin is one file, `dist/opencode-task-driver.js` (committed; `npm run build` regenerates it from `src/`). It is
not published to npm.

**Copy it into a plugin directory.** opencode loads `*.js` files from `~/.config/opencode/plugin/` (all projects) and
from a project's `.opencode/plugin/` (`plugins/` works too). Options cannot be passed this way; use
`OPENCODE_TASK_DRIVER` for the mode, and the other options keep their defaults.

**Or name it in `opencode.json`**, with options:

```json
{
  "plugin": [
    ["file:///path/to/opencode-task-driver/dist/opencode-task-driver.js", { "mode": "tasks" }]
  ]
}
```

`opencode run --pure` skips every external plugin, this one included.

## Configuration

All options are optional.

| option | default | meaning |
|---|---|---|
| `mode` | `tasks` | `tasks`, `enforce` or `off`; the environment variable `OPENCODE_TASK_DRIVER` overrides it |
| `delivery` | `auto` | how follow-ups are sent: `prompt`, `file` or `auto`; see [`opencode run`](#opencode-run-and-outside-drivers) |
| `dir` | `$XDG_DATA_HOME/opencode/task-driver` (else `~/.local/share/opencode/task-driver`) | where the state files and the event log go |
| `maxNudgesPerTask` | `2` | follow-ups for one task (or todo item) before it is set aside as unfinished |
| `maxPrompts` | `24` | follow-ups per session, all kinds together |
| `finalPass` | `true` | ask for one full test run once every task is closed |

Fixed limits: 40 tasks per session; longer text is clipped at 200 characters for a title, 20,000 for task details and
4,000 for a note, a summary or a reason; a task keeps its last 50 notes.

## How it works

1. **Planning.** Until tasks are filed, every main-agent request carries a short system-prompt block (832 characters):
   if the request contains more than one separate problem, call `file_tasks` before starting, one task per problem,
   each written out completely (symptoms, exact error text and quotes, expected behaviour, constraints, where to look)
   so it can be done from its own text alone.
2. **The list lives outside the conversation**, in a JSON state file per session. From then on every request carries
   the *current* task in full (details and notes) plus the titles and status of the others. The block changes only
   when the current task changes, a task is added or closed, or the session is compacted, so the system prompt stays
   byte-identical across the steps of one task and a model server's prompt cache keeps its prefix. When opencode
   compacts the session, the task list (status, notes, summaries) goes into the summarizer's prompt.
3. **Tools** (`tasks` mode):

   | tool | what it does |
   |---|---|
   | `file_tasks(tasks[{title, details}])` | files the list (once); returns task 1 in full |
   | `add_task(title, details)` | adds a separate problem found while working |
   | `task_note(id, text)` | records a finding or progress; notes survive compaction and are shown with the task |
   | `finish_task(id, summary)` | closes a task; the summary of what changed is optional; returns the next task in full |
   | `give_up_task(id, reason)` | closes a task that cannot be done; returns the next task |
   | `list_tasks()` | the list with statuses, and the current task in full |

   opencode 1.18 shows every top-level argument of a plugin tool as required, so the model sees `summary` as required;
   its description says it may be left empty, and an empty or missing one is accepted.
4. **One at a time.** When the session goes idle with the current task still open, the plugin sends a follow-up:
   "Task k of N (title) is still open." plus the task's full text and "Continue working on this task. When it is done,
   call finish_task; if it cannot be done, call give_up_task with the reason." After 2 follow-ups the task is set aside
   as unfinished and the next one is handed over in full.
5. **Final pass.** When every task is closed, one request to run the project's full test suite (or the closest
   equivalent) once, to check the changes work together; then the plugin stops. If the agent closed the last task
   itself, this request is part of the `finish_task` / `give_up_task` result (no extra turn); if the plugin set the last
   task aside, it is a follow-up.
6. **Caps and safety.** At most 24 follow-ups per session. No follow-up after an error or an abort (a failure is never
   turned into another turn). Sub-agent sessions are left alone, and opencode's title and summary requests get nothing.

Everything the model sees is plain workflow language. The agent is never asked to state or prove how it checked a
task.

## `opencode run` and outside drivers

The TUI and `opencode serve` keep running, so the plugin sends its follow-ups itself through the SDK client's
`session.promptAsync` (`delivery: "prompt"`).

`opencode run "..."` does not: it exits a few milliseconds after the session first goes idle, and a follow-up sent from
inside it is stored but never answered. So inside `opencode run` the plugin only records the follow-up it decided
(`delivery: "file"`; the default `auto` picks `file` inside `opencode run` and `prompt` everywhere else). The state file
`<dir>/<session id>.json` gets a `pending` entry `{id, kind, task, text}`, and a script sends it as the next turn of the
same session:

```sh
dir=~/.local/share/opencode/task-driver
opencode run --format json "$REQUEST" > turn0.jsonl
sid=$(jq -r 'select(.sessionID) | .sessionID' turn0.jsonl | head -1)
n=0
while text=$(jq -er '.pending.text' "$dir/$sid.json" 2>/dev/null); do
  n=$((n + 1)); opencode run --format json --session "$sid" "$text" > "turn$n.jsonl"
done
```

The plugin recognises the text when it arrives (including the quoting `opencode run` adds to a message argument with
spaces) and counts it as delivered. If anything else is sent instead, the pending follow-up is dropped and the next idle
decides afresh. Counters live in the state file, so they carry over from one process to the next.

With `opencode run --attach <server>` the plugin runs in the server, which answers its own follow-ups after the `run`
client has exited.

## Files

- `<dir>/<session id>.json`: the session's state (tasks with status, notes, summary or reason; counters; `pending`).
  Written atomically (temp file + rename) and synchronously, because `opencode run` disposes the plugin a few
  milliseconds after idle.
- `<dir>/.events.jsonl`: one line per event (`loaded`, `filed`, `noted`, `finished`, `gave-up`, `followup`,
  `delivered`, `superseded`, `compacted`, `shown`, `stopped`, `error`, ...), for whoever wants to know what happened.

## Hooks used

| hook | stable? | used for |
|---|---|---|
| `tool` | stable | the six task tools (`tasks` mode). Arguments are plain JSON Schema, which opencode 1.18 accepts for plugin tools; the plugin validates them itself (local models often send arrays and numbers as strings) |
| `event` | stable | `session.status` / `session.idle` (follow-ups), `session.error` and assistant `message.updated` errors (no follow-up after a failure or abort), `session.created` / `session.updated` (sub-agent sessions are skipped), `session.compacted`, `todo.updated` (`enforce`) |
| `chat.message` | stable | a follow-up arrived (delivered) or the user said something else; remembers the agent and model for `promptAsync` |
| `experimental.chat.messages.transform` | **experimental** | marks "the next system prompt belongs to a main-agent request" (title and summary requests get nothing) |
| `experimental.chat.system.transform` | **experimental** | adds the planning block / the task block |
| `experimental.session.compacting` | **experimental** | puts the task list into the summarizer's prompt |
| `dispose` | stable | a last state write |

The experimental hooks can change shape in any opencode release; the tests pin the 1.18.34 behaviour.

## Limits

- The model has to call `file_tasks`. A model that ignores the planning block gets plain opencode behaviour, plus the
  planning block on each request (byte-stable, so a prompt cache absorbs it).
- Splitting is only as good as the model's task texts. The instructions ask for lossless copies of the request, but a
  detail left out of a task cannot be recovered from the task alone; the original request stays in the conversation
  until the first compaction.
- Follow-ups add turns: per task at most 2 follow-ups plus the hand-over to the next task (or the final pass), and never
  more than 24 per session.
- `enforce` counts only what `todowrite` says; a model that never keeps a todo list is never followed up.
- Sub-agent sessions are never driven or injected into (they can still call the tools, which keep a separate list).
- Exercised with `opencode run`, `opencode serve` (HTTP) and the plain TUI.

## Compatibility

Tested with opencode 1.18.34 and the `@opencode-ai/plugin` 1.17.20 types, on Linux. Other 1.18.x releases are likely to
work; the three experimental hooks are the part most likely to break across opencode releases. If a future version
changes them, run the end-to-end test below against it.

## Tests

```sh
npm test       # builds dist/ from src/, then the unit tests: the core state machine, and the adapter driven with
               # opencode's event order (both src/ and the built file)
npm run e2e    # end to end against the real opencode binary and a scripted mock model
```

`npm test` needs Node 18 or newer and nothing else.

`npm run e2e` (`test/e2e/e2e.mjs [serve|run|probe|enforce|enforce-serve|all] [--out DIR]`) runs opencode against a
local mock model, with no GPU and no network. It needs:

- Linux with bubblewrap (`bwrap`): the test re-runs itself inside `bwrap --unshare-net`. `--no-sandbox` skips that, at
  the risk of opencode reaching for the network.
- opencode 1.18.x on `PATH` (or at `~/.opencode/bin/opencode`), run at least once so `~/.cache/opencode` exists; it is
  copied into the test's own XDG directories so nothing is fetched.
- an existing `@opencode-ai/plugin` install in `~/.config/opencode` (`package.json` + `node_modules`, which opencode
  creates on first start). Without it every opencode start waits about 70 s for an install that cannot happen offline.

Your opencode setup and sessions are not touched: each mode gets its own XDG config, data, state and cache directories
and a scratch git workspace. Each mode writes a readable `transcript.md`. The scenario: a three-problem request; the
model files three tasks, fixes the first (with a note that survives a forced compaction), stalls on the second (two
follow-ups, then it is set aside), is handed the third, finishes it, runs the final test pass, and stops. `probe` checks
that `opencode run` still exits at the first idle without answering an in-process follow-up, so an opencode upgrade
that changes this shows up.

## Versions

- **0.2.0**: the design described here.
- **0.1.0** (the first commit): the same task list, but the agent also wrote, for every task, how to tell it was done,
  and had to say how it verified each task before closing it. In our use those per-task checks cost a lot of time and
  output and rarely changed what got fixed. 0.2.0 replaces it.

## License

MIT: see `LICENSE`.
