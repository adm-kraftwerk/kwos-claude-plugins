#!/usr/bin/env node
// A2A delegation as an MCP tool (WI 11614379). One tool, one implementation:
// `kwclaude a2a delegate` already knows how a session names itself and its order (session marker
// -> /v1/a2a/sessions/:session/lineage), so this server only exposes that command to the model
// instead of re-implementing the gateway calls a second time.
//
// Zero dependencies on purpose: a plugin is cloned, not installed. The MCP stdio transport is
// newline-delimited JSON-RPC, so the four methods below are the whole protocol this tool needs.
//
// The command resolves the target agent, sends the A2A message with metadata callerBotId /
// parentTaskId, and lets the gateway's adapter decide about the corridor. A refusal is returned as
// an error result with the command's own sentence; nothing here invents a reason.

import { spawn } from "node:child_process";

const SERVER_INFO = { name: "a2a", version: "1.0.0" };
const PROTOCOL_VERSION = "2024-11-05";
const TIMEOUT_MS = 90_000;
const OUTPUT_MAX = 32 * 1024;

const TOOL = {
  name: "a2a_delegate",
  description:
    "Übergibt aus einer laufenden Bot-Sitzung Arbeit an einen anderen A2A-Agenten. Der Bot nennt " +
    "sich und seinen laufenden Auftrag selbst (Lineage der Sitzung); das Gateway prüft den " +
    "Delegationskorridor und die Tiefe. Antwort: Task-ID und Zustand, oder die Absage im Klartext.",
  inputSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: "Agentenname, z. B. kraftwerk.bot-reviewer-0123456789 (aus `kwclaude a2a agents`)",
      },
      message: { type: "string", description: "Der Auftrag als Text" },
    },
    required: ["target", "message"],
    additionalProperties: false,
  },
};

function run(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (code, note) => {
      if (done) return;
      done = true;
      resolve({ code: code ?? 1, stdout: stdout.slice(0, OUTPUT_MAX), stderr: (stderr || note || "").slice(0, OUTPUT_MAX) });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(124, `timeout after ${timeoutMs} ms`);
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => { clearTimeout(timer); finish(127, `cannot start ${command}: ${e.message}`); });
    child.on("close", (code) => { clearTimeout(timer); finish(code); });
  });
}

async function delegate(args) {
  const target = typeof args?.target === "string" ? args.target.trim() : "";
  const message = typeof args?.message === "string" ? args.message.trim() : "";
  if (target === "" || message === "") {
    return { isError: true, text: "target und message sind Pflicht" };
  }
  // No shell: the arguments go as an array, so a target or a message cannot become a command.
  const out = await run("kwclaude", ["a2a", "delegate", target, message], TIMEOUT_MS);
  const text = (out.stdout.trim() || out.stderr.trim() || `kwclaude a2a delegate endete mit ${out.code}`);
  return { isError: out.code !== 0, text };
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    fail(null, -32700, "parse error");
    return;
  }
  const { id, method, params } = request ?? {};
  // Notifications carry no id and get no answer.
  if (method === "initialize") {
    reply(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    return;
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "ping") {
    reply(id, {});
    return;
  }
  if (method === "tools/list") {
    reply(id, { tools: [TOOL] });
    return;
  }
  if (method === "tools/call") {
    if (params?.name !== TOOL.name) {
      fail(id, -32602, `unknown tool ${String(params?.name)}`);
      return;
    }
    const out = await delegate(params?.arguments);
    reply(id, { content: [{ type: "text", text: out.text }], isError: out.isError });
    return;
  }
  fail(id, -32601, `unsupported method ${String(method)}`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line !== "") void handle(line);
  }
});
process.stdin.on("end", () => process.exit(0));
