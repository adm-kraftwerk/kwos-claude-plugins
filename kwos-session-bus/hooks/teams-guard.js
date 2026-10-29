#!/usr/bin/env node
// The hook entry for `server/teamsGuard.js` (WI 11569154): one event per run, either
// `userpromptsubmit` (the reminder before every prompt) or `pretooluse` (the refusal of a
// Teams send). The answers are pure and tested there; this file only does the I/O.
//
// NEVER COSTS THE PROMPT. An unreadable payload, a broken import, anything: exit 0 with
// what we have. A guard that fails loud on every prompt would be the next defect.

import { hookAnswer } from "../server/teamsGuard.js";

async function main() {
  const event = String(process.argv[2] || "").trim().toLowerCase();
  let payload = {};
  try {
    const raw = await readStdin();
    if (raw.trim() !== "") payload = JSON.parse(raw);
  } catch {
    // No payload: the reminder still applies, and there is no tool call to judge.
    payload = {};
  }
  const answer = hookAnswer(event, payload);
  if (answer !== null) process.stdout.write(JSON.stringify(answer));
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
    process.stdin.resume();
  });
}

// The same entry pattern as `code-hook.js`: the write is flushed before the exit (a
// process.exit right after write() can cut the JSON the harness reads).
main().catch(() => {}).finally(() => process.stdout.write("", () => process.exit(0)));
