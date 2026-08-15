#!/usr/bin/env node
// SessionStart hook: writes the real Claude Code session_id into a marker file in the project
// directory. Neither the stdio MCP server nor a monitors-launched process receives
// CLAUDE_CODE_SESSION_ID in its environment, so both would otherwise register under a random,
// unrelated session_id (see server/config.js, resolveSessionId).

import { writeFileSync } from "node:fs";
import { join } from "node:path";

let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(raw);
    if (payload.session_id && payload.cwd) {
      writeFileSync(join(payload.cwd, ".kwos-session-bus-id"), payload.session_id, "utf8");
    }
  } catch {
    // Never block session start on a hook failure.
  }
  process.exit(0);
});
