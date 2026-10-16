#!/usr/bin/env node
// SessionStart hook: writes the real Claude Code session_id into a marker file.
//
// WHY A FILE AT ALL, STILL: `CLAUDE_CODE_SESSION_ID` IS in the environment of a process started
// the way the MCP server or a `monitors` process is started -- measured 2026-10-14 on a live
// session (the value sat in the environment of a shell-spawned node process, next to the
// launcher's KWOS_* exports). The comment here used to say the opposite; that is why the marker
// exists. The ENV value has one flaw the file does not: it is frozen at process start. After
// `/clear` and `--resume` Claude Code hands out a NEW session id inside the same process, and
// every already-running child keeps the old one -- the relay hooks then register the session
// under the new id while the listener still subscribes under the old one, and a message sent to
// the session the PWA shows reaches nobody (it stays in relay.messages as "queued"). The file is
// rewritten on every SessionStart, so it carries the current truth; the env value is only the
// starting point.
//
// WHY PER CLIENT (KWOS_CLIENT_ID) AND NOT ONE FILE PER DIRECTORY: one plain
// `.kwos-session-bus-id` per project directory is last-writer-wins. Two sessions in the same
// directory share it, and whichever started last wins -- the other session's listener registers
// and subscribes under a foreign session_id. The launcher exports KWOS_CLIENT_ID
// (`cli-<pid>-<rand>`, one per launched claude process; it survives /clear and --resume because
// the process does). Keying the marker by it makes the lookup exact instead of a guess. The
// plain file is still written, for readers older than this change.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MARKER_DIR, LEGACY_MARKER_FILE, clientMarkerName } from "../server/sessionMarker.js";

let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(raw);
    if (payload.session_id && payload.cwd) {
      writeFileSync(join(payload.cwd, LEGACY_MARKER_FILE), payload.session_id, "utf8");
      const name = clientMarkerName(process.env.KWOS_CLIENT_ID);
      if (name) {
        mkdirSync(join(payload.cwd, MARKER_DIR), { recursive: true });
        writeFileSync(join(payload.cwd, MARKER_DIR, name), payload.session_id, "utf8");
      }
    }
  } catch {
    // Never block session start on a hook failure.
  }
  process.exit(0);
});
