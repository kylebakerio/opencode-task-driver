// A content-aware OpenAI-compatible chat server for the end-to-end test: no GPU, no model, no network.
// Title requests get a title, summarizer requests (no tools) get a summary, and agent requests get whatever
// scenario.mjs decides from the request itself (the system prompt's task block, the last message).
// Every request is logged; GET /__log returns the log.
import http from "node:http";
import crypto from "node:crypto";
import { decide, decideEnforce, textOf } from "./scenario.mjs";

// what the task tools take, as opencode sent them to the model
const argsOf = (body, name) => { const t = (body.tools || []).find((x) => x.function && x.function.name === name); return t ? t.function.parameters : undefined; };
// the plugin's own block in the system prompt (opencode's prompt around it says what it says)
const pluginBlock = (sys) => (sys.match(/<task_(planning|list)>[\s\S]*?<\/task_\1>/) || [null])[0];

// the plugin's part of the summarizer's prompt (its lines have no blank line; opencode's own template is around it)
const pluginContext = (msgs) => {
  const t = msgs.map((m) => textOf(m.content)).find((x) => /This session keeps a task list outside the conversation/.test(x));
  return t ? t.slice(t.indexOf("This session keeps a task list outside the conversation")).split("\n\n")[0] : null;
};

// strict: reject (HTTP 500, as llama.cpp does) any request with a system message that is not the first message, as
// chat templates that take one leading system message do (Qwen3.8 Flash-Next: "System message must be at the beginning").
export function startMock(port, { scenario = "tasks", strict = false } = {}) {
  const log = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url.endsWith("/models")) return json(res, 200, { object: "list", data: [{ id: "mock-20k", object: "model" }] });
      if (req.method === "GET" && req.url === "/__log") return json(res, 200, log);
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch {}
      const msgs = body.messages || [];
      if (strict && msgs.some((m, i) => i > 0 && m.role === "system")) {
        log.push({ i: log.length, kind: "rejected", system_parts: msgs.filter((m) => m.role === "system").length });
        return json(res, 500, { error: { code: 500, message: "System message must be at the beginning.", type: "server_error" } });
      }
      const system = msgs.filter((m) => m.role === "system").map((m) => textOf(m.content));
      const sysText = system.join("\n");
      let kind, reply;
      if (/You are a title generator/.test(sysText)) { kind = "title"; reply = { text: "Fix three problems" }; }
      else if (!body.tools || !body.tools.length) {
        kind = "compaction";
        reply = { text: "## Summary\nWe filed three tasks and fixed config.txt (task 1); a note was recorded.", ptok: 600 };
      } else { kind = "agent"; reply = scenario === "enforce" ? decideEnforce(body) : decide(body, sysText); }
      const last = msgs[msgs.length - 1] || {};
      log.push({
        i: log.length, kind, system_sha: crypto.createHash("sha256").update(JSON.stringify(system)).digest("hex").slice(0, 12),
        system_parts: system.length, current: (sysText.match(/Current task: (\d+) of (\d+)/) || [])[1] || (/<task_planning>/.test(sysText) ? "planning" : /tasks in this session's task list are closed/.test(sysText) ? "closed" : null),
        last_role: last.role, last_text: textOf(last.content).slice(0, 300),
        task_tools: kind === "agent" ? (body.tools || []).some((t) => t.function && t.function.name === "file_tasks") : undefined,
        todowrite_tool: kind === "agent" ? (body.tools || []).some((t) => t.function && t.function.name === "todowrite") : undefined,
        compaction_has_tasklist: kind === "compaction" ? msgs.some((m) => /keeps a task list outside the conversation/.test(textOf(m.content))) : undefined,
        compaction_text: kind === "compaction" ? pluginContext(msgs) : undefined,
        plugin_block: kind === "agent" ? pluginBlock(sysText) : undefined,
        task_args: kind === "agent" && argsOf(body, "file_tasks") ? { file_tasks: argsOf(body, "file_tasks"), add_task: argsOf(body, "add_task"), finish_task: argsOf(body, "finish_task") } : undefined,
        reply: reply.tool ? { tool: reply.tool, args: reply.args } : { text: reply.text },
      });
      send(res, body, reply, log.length);
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, log })));
}

function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": b.length }); res.end(b);
}

function send(res, body, item, n) {
  const id = "chatcmpl-" + crypto.randomBytes(6).toString("hex"), now = Math.floor(Date.now() / 1000);
  const pt = item.ptok || 1000;
  const usage = { prompt_tokens: pt, completion_tokens: 40, total_tokens: pt + 40 };
  let delta, finish;
  if (item.tool) {
    delta = { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name: item.tool, arguments: JSON.stringify(item.args || {}) } }] };
    finish = "tool_calls";
  } else { delta = { role: "assistant", content: item.text || "" }; finish = "stop"; }
  if (!body.stream) return json(res, 200, { id, object: "chat.completion", created: now, model: body.model, choices: [{ index: 0, message: delta, finish_reason: finish }], usage });
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const base = { id, object: "chat.completion.chunk", created: now, model: body.model };
  const w = (o) => res.write("data: " + JSON.stringify(o) + "\n\n");
  w({ ...base, choices: [{ index: 0, delta, finish_reason: null }] });
  w({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
  w({ ...base, choices: [], usage });
  res.end("data: [DONE]\n\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] || 18080), scenario = process.argv[3] || "tasks";   // node mock-llm.mjs [port] [tasks|enforce] [strict]
  const strict = process.argv[4] === "strict";
  startMock(port, { scenario, strict }).then(() => console.log(`mock (${scenario}${strict ? ", strict" : ""}) on 127.0.0.1:${port}`));
}
