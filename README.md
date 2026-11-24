# opencode-task-driver

An [opencode](https://opencode.ai) plugin that makes the agent split a request holding several separate problems into a
task list, keep that list outside the conversation, and work the tasks one at a time.

Why: given one request with several bugs in it, local models tend to fix some and stop, or never look at the code of
the others; the same bug is solved more often when it is posed on its own. The plugin turns a multi-problem request
into a sequence of single-problem requests without changing what the user types.

Tested against opencode 1.18.34 (plugin types `@opencode-ai/plugin` 1.17.20). One file, no dependencies.

## How it works

1. **Planning.** While nothing is filed, every main-agent request carries a short system-prompt block (about 870
   characters): if the request contains more than one separate problem, call `file_tasks` before starting, one task per
   problem, each written out completely and losslessly (symptoms, exact error text and quotes, expected behaviour,
   constraints, where to look, how to tell it is done) so it can be done from its own text alone. A single-problem
   request files nothing, and nothing else happens: no tools are called, no follow-ups are sent.
2. **The list lives outside the conversation**, in a JSON state file per session. Every request then carries the
   *current* task in full (details, done-when, notes) plus the titles and status of the others. That block only changes
   when the current task changes, a task is added or closed, or the session is compacted, so the system prompt stays
   byte-identical across the steps of one task and a model server's prompt cache keeps its prefix. When opencode
   compacts the session, the list (with each task's status, evidence and notes) goes into the summarizer's prompt too.
3. **Tools** (only in `full` mode):

   | tool | what it does |
   |---|---|
   | `file_tasks(tasks[{title, details, done_when}])` | files the list (once); returns task 1 in full |
   | `add_task(title, details, done_when)` | another separate problem found while working |
   | `task_note(id, text)` | records a finding or progress; notes survive compaction and are shown with the task |
   | `finish_task(id, evidence)` | closes a task; evidence (how it was verified) is required; returns the next task in full |
   | `give_up_task(id, reason)` | closes a task that cannot be done; returns the next task |
   | `list_tasks()` | the list with statuses, and the current task in full |

4. **One at a time.** When the session goes idle with the current task still open, the plugin sends a follow-up:
   "Task k of N (title) is still open: <the task's full text>. Continue working on this task. When it is done and
   checked, call finish_task with how you verified it; if it cannot be done, call give_up_task with the reason." At most
   2 follow-ups per task; after that the task is set aside as unfinished and the next one is handed over in full.
5. **Final pass.** When every task is closed, one request to run the project's full test suite (or the closest
   equivalent) once, to check the changes did not break each other; then the plugin stops. When the model closes the
   last task itself, this request is part of the `finish_task` / `give_up_task` result (no extra turn); when the plugin
   sets the last task aside, it is a follow-up prompt.
6. **Caps.** At most 24 follow-ups per session in all (`maxPrompts`). No follow-up after an error or an abort (a
   failure is never turned into another turn), and none for sub-agent sessions, which are left alone entirely.

Everything the model sees is plain workflow language.

## Modes

Set with the environment variable `OPENCODE_TASK_DRIVER` (wins) or the `mode` option:

- `full` (default): everything above.
- `enforce`: the lightest touch. No tools, no instructions, nothing injected. When the session goes idle and
  the model's *own* todo list (opencode's built-in `todowrite`, mirrored from `todo.updated` events) still has
  `pending` / `in_progress` items, one follow-up asks it to continue them ("Your todo list still has open items: ...
  Continue working on them. If an item is already done or no longer needed, update the todo list to say so."). Same
  caps: 2 follow-ups per item, 24 per session.
- `off`: the plugin loads and does nothing.

## Install

Build (or use the committed build): `npm run build` writes `dist/opencode-task-driver.js`.

Either copy that one file into a plugin directory opencode reads (`~/.config/opencode/plugin/` or a project's
`.opencode/plugin/`), or name it in `opencode.json`, with options if you want them:

```json
{
  "plugin": [
    ["file:///path/to/opencode-task-driver/dist/opencode-task-driver.js", { "mode": "full" }]
  ]
}
```

Options (all optional):

| option | default | meaning |
|---|---|---|
| `mode` | `full` | `full`, `enforce` or `off` (the env var `OPENCODE_TASK_DRIVER` overrides it) |
| `delivery` | `auto` | how follow-ups are sent, see below |
| `dir` | `$XDG_DATA_HOME/opencode/task-driver` | where the state files and the event log go |
| `maxNudgesPerTask` | 2 | follow-ups for one task (or todo item) before it is set aside |
| `maxPrompts` | 24 | follow-ups per session, all kinds together |
| `finalPass` | true | ask for the closing full test run |

`opencode run --pure` skips every external plugin, this one included.

## Delivery: `opencode run` ends at the first idle

The TUI and `opencode serve` keep running, so the plugin can send its follow-up itself (`client.session.promptAsync`)
and the model answers it (`delivery: "prompt"`).

`opencode run "..."` does not: it stops listening as soon as the session first goes idle and exits a few milliseconds
later. A follow-up sent from inside it is stored in the session but never answered (`node test/e2e/e2e.mjs probe`
checks exactly this). So inside `opencode run` the plugin only **records** the follow-up it decided (`delivery:
"file"`; `auto`, the default, picks `file` inside `opencode run` and `prompt` elsewhere): the state file
`<dir>/<session id>.json` gets a `pending` entry `{id, kind, task, text}`, and an outside driver sends it as one more
turn of the same session:

```sh
dir=~/.local/share/opencode/task-driver
opencode run --format json "$REQUEST" > turn0.jsonl
sid=$(jq -r 'select(.sessionID) | .sessionID' turn0.jsonl | head -1)
n=0
while text=$(jq -er '.pending.text' "$dir/$sid.json" 2>/dev/null); do
  n=$((n + 1)); opencode run --format json --session "$sid" "$text" > "turn$n.jsonl"
done
```

The plugin sees the text arrive and counts it as delivered (it also recognises the quoting `opencode run` adds to a
message argument that contains spaces). If anything else is sent instead, the pending follow-up is dropped
("superseded") and the next idle decides afresh. Counters live in the state file, so they carry over from one process
to the next.

## Files

- `<dir>/<session>.json`: the state (tasks with status, notes, evidence; counters; `pending`). Written atomically
  (temp file + rename), synchronously, because `opencode run` disposes the plugin a few milliseconds after idle.
- `<dir>/.events.jsonl`: one line per event (`loaded`, `filed`, `noted`, `finished`, `gave-up`, `followup`,
  `delivered`, `superseded`, `compacted`, `shown`, `stopped`, `error`, ...), for whoever wants to know what happened.

## Hooks used

All verified against the installed `@opencode-ai/plugin` 1.17.20 types and the opencode 1.18.34 binary.

| hook | stable? | used for |
|---|---|---|
| `tool` | stable | the six task tools (`full` mode only). Arguments are plain JSON Schema, which 1.18 accepts for plugin tools; the plugin validates them itself (local models send strings for arrays and numbers) |
| `event` | stable | `session.status` / `session.idle` (follow-ups), `session.error` and assistant `message.updated` errors (no follow-up after a failure or abort), `session.created` / `session.updated` (sub-agent sessions are skipped), `session.compacted`, `todo.updated` (`enforce`) |
| `chat.message` | stable | a follow-up arrived (delivered) or the user said something else (superseded); remembers the agent and model for `promptAsync` |
| `experimental.chat.messages.transform` | **experimental** | marks "the next system prompt belongs to a main-agent request" (the title and summary requests get nothing) |
| `experimental.chat.system.transform` | **experimental** | the planning block / the task block |
| `experimental.session.compacting` | **experimental** | the task list goes into the summarizer's prompt (`output.context`) |
| `dispose` | stable | a last state write |

Follow-ups use the SDK client's `session.promptAsync`. The experimental hooks can change shape in any opencode release;
the tests pin the 1.18.34 behaviour.

## Limits and risks

- The model has to call `file_tasks`. A model that ignores the planning block gets plain opencode behaviour (plus the
  ~870-character block on each request, which is byte-stable and so cached).
- Splitting is only as good as the model's task texts. The instructions push for lossless copies of the request, but a
  task written without a detail cannot be done from its own text; the original request is still in the conversation
  until the first compaction.
- Follow-ups add turns: per task at most 2 follow-ups plus the hand-over to the next task (or the final pass), so up to
  3 per task, never more than 24 per session.
- `enforce` mode counts only what `todowrite` says; a model that never keeps a todo list is never nudged.
- Sub-agent sessions are never driven or injected into (they may still call the tools, which keep a separate list).
- Only `opencode run`, `opencode serve` (HTTP) and the plain TUI were exercised. With `opencode run --attach <server>`
  the plugin runs in the server, which answers the follow-up after the `run` client has exited.
- Tested on Linux with opencode 1.18.34 only.

## Tests

```sh
npm test            # build + unit tests (core state machine, and the adapter driven with opencode's event order)
npm run e2e         # end to end against the real opencode binary and a scripted mock model; no GPU, no network
```

The e2e (`test/e2e/e2e.mjs`) runs inside `bwrap --unshare-net` with its own XDG directories, so your opencode setup and
sessions are untouched. Modes: `serve` (the plugin sends follow-ups itself), `run` (an outside driver re-runs
`opencode run --session`), `probe` (does `opencode run` answer an in-process follow-up? no), `enforce` and
`enforce-serve` (todo-list follow-ups only). Each writes a readable `transcript.md`. The full scenario: a three-problem
request; the model files three tasks, fixes the first (with a note that survives a forced compaction), stalls on the
second (two follow-ups, then it is set aside), is handed the third, finishes it, runs the final test pass, and stops.

## License

MIT: see `LICENSE`.
