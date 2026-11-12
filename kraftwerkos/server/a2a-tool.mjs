#!/usr/bin/env node
// A2A delegation as an MCP tool (WI 11614379). One tool, one implementation:
// `kwclaude a2a delegate` already knows how a session names itself and its order (session marker
// -> /v1/a2a/sessions/:session/lineage), so this server only exposes that command to the model
// instead of re-implementing the gateway calls a second time. It starts the same command the
// fleet's starter starts (`node <cfg>/kwterm-node/dist/kwterm.mjs`) -- see `invocation`.
//
// Zero dependencies on purpose: a plugin is cloned, not installed. The MCP stdio transport is
// newline-delimited JSON-RPC, so the four methods below are the whole protocol this tool needs.
//
// The command resolves the target agent, sends the A2A message with metadata callerBotId /
// parentTaskId, and lets the gateway's adapter decide about the corridor. A refusal is returned as
// an error result with the command's own sentence; nothing here invents a reason.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SERVER_INFO = { name: "a2a", version: "1.0.0" };
const PROTOCOL_VERSION = "2024-11-05";
const TIMEOUT_MS = 90_000;
const OUTPUT_MAX = 32 * 1024;

// The fleet's own starter runs the CLI as `node <cfg>/kwterm-node/dist/kwterm.mjs`
// (`kwos-sync.ps1`, `_build_kwterm`): the bundle beside the config, started by an interpreter.
const CFG_DIR = process.env.KWOS_CONFIG_DIR || join(homedir(), ".config", "kraftwerk");
const KWTERM_BUNDLE =
  process.env.KWOS_KWTERM_BUNDLE || join(CFG_DIR, "kwterm-node", "dist", "kwterm.mjs");

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

/**
 * The command, and the interpreter that starts it (measured 2026-11-12 on the Windows specimen).
 *
 * `spawn("kwclaude", ...)` cannot work there: on Windows `kwclaude` is `kwclaude.cmd`, and Node
 * refuses to start a `.cmd` without a shell (`EINVAL`); by bare name it is `ENOENT`, because the
 * process is started without the PATHEXT search. Going through `cmd.exe` instead would parse this
 * order a SECOND time -- `&`, `|`, `<`, `>` and `%` would arrive as commands instead of as text,
 * and the order is a sentence a model wrote.
 *
 * So the same way the fleet's starter does it: `node <cfg>/kwterm-node/dist/kwterm.mjs`, arguments
 * as an ARRAY, no shell, on every platform. `kwclaude` by name stays the fallback where it is a
 * startable program (POSIX); on Windows a missing bundle is a sentence, not a broken start.
 */
function invocation(args) {
  if (existsSync(KWTERM_BUNDLE)) return { file: process.execPath, args: [KWTERM_BUNDLE, ...args] };
  if (process.platform !== "win32") return { file: "kwclaude", args };
  return {
    error:
      `kwterm fehlt (${KWTERM_BUNDLE}) -- den Befehl gibt es hier erst, wenn das Bundle gebaut ist; ` +
      "`kwclaude selfupdate` baut es.",
  };
}

function run(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      // A start that throws (rather than emitting `error`) would reject this promise and leave the
      // tool call unanswered; the model gets the reason instead.
      resolve({ code: 127, stdout: "", stderr: `cannot start ${command}: ${e.message}`.slice(0, OUTPUT_MAX) });
      return;
    }
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
  const call = invocation(["a2a", "delegate", target, message]);
  if (call.error !== undefined) return { isError: true, text: call.error };
  const out = await run(call.file, call.args, TIMEOUT_MS);
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
// A closed stdin is not the end of the work: a delegation that is still running would lose its
// answer silently (measured 2026-11-12 -- the call was in flight, the process exited, no reply).
let pending = 0;
let closing = false;
const settle = () => {
  pending -= 1;
  if (pending === 0 && closing) process.exit(0);
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line === "") continue;
    pending += 1;
    // A handler that throws must not become an unhandled rejection (Node ends the process on it);
    // the caller gets the reason instead, and the server keeps serving.
    void handle(line)
      .catch((e) => fail(null, -32603, `internal error: ${e?.message ?? String(e)}`))
      .finally(settle);
  }
});
process.stdin.on("end", () => {
  closing = true;
  if (pending === 0) process.exit(0);
});
