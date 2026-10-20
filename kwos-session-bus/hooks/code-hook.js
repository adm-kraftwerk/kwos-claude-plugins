#!/usr/bin/env node
// kwcollab code exchange (WI 11517979) -- the hooks of a session in code mode.
//
//   code-hook.js stop        Stop: publish this turn's state, take in the others', one summary line
//   code-hook.js pretooluse  PreToolUse (Edit|Write|MultiEdit|NotebookEdit): wait for a sync when
//                            another member's state changes the file and is not here yet
//
// RUNS IN EVERY SESSION WITH THIS PLUGIN, so the first thing it does is decide -- WITHOUT the
// network -- whether there is anything to do: the channel must be released on this machine
// (KWOS_COLLAB_CANARY, the same gate as the tools) and this worktree must have joined code mode
// (its git dir holds kwcollab/state.json). Everywhere else it exits 0 at once, silently.
//
// NEVER BLOCKS THE SESSION ON ITS OWN FAILURE. A broken relay or a git error turns into a
// systemMessage the human sees (a silent failure would leave two people believing they share a
// state they do not), never into a blocked turn or a failed tool call. The precheck is fail-open
// for the same reason, and says so.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { collabReleased } from "../server/collab-listen.js";

const mode = process.argv[2];

function readStdin() {
  return new Promise((resolve) => {
    let raw = "";
    process.stdin.on("data", (c) => { raw += c; });
    process.stdin.on("end", () => resolve(raw));
    process.stdin.on("error", () => resolve(raw));
  });
}

// Cheap local test: is this worktree in code mode at all? One `git rev-parse`, no network.
function inCodeMode(cwd) {
  if (!cwd) return false;
  const r = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return false;
  return existsSync(join(r.stdout.trim(), "kwcollab", "state.json"));
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

async function main() {
  const raw = await readStdin();
  if (!collabReleased()) return;
  let payload = {};
  try { payload = JSON.parse(raw || "{}"); } catch { return; }
  const cwd = payload.cwd || process.cwd();
  if (!inCodeMode(cwd)) return;

  // Only now: the modules that talk to the relay (they read the session marker, the token helper).
  const runtime = await import("../server/codeRuntime.js");
  if (mode === "stop") {
    // A Stop hook that is itself the reason for a continuation must not run again (Claude Code sets
    // stop_hook_active then) -- one summary per turn, not a loop.
    if (payload.stop_hook_active) return;
    let line = null;
    try { line = await runtime.turnEnd({ cwd }); } catch (e) { line = `kwcollab: Abgleich ging nicht: ${e?.message || e}`; }
    if (line) process.stdout.write(JSON.stringify({ systemMessage: line }));
    return;
  }
  if (mode === "pretooluse") {
    if (!EDIT_TOOLS.has(payload.tool_name)) return;
    const input = payload.tool_input || {};
    const path = input.file_path || input.notebook_path || input.path;
    let reason = null;
    try { reason = await runtime.precheck({ cwd, path }); } catch (e) {
      process.stdout.write(JSON.stringify({ systemMessage: `kwcollab: Vorabprüfung ging nicht (${e?.message || e}) -- die Änderung läuft trotzdem.` }));
      return;
    }
    if (reason) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
      }));
    }
  }
}

// Exit only after stdout is flushed: on a pipe, process.exit() right after write() can cut the
// JSON the harness reads (review finding 2026-10-20). An empty write's callback is the flush point.
main().catch(() => {}).finally(() => process.stdout.write("", () => process.exit(0)));
