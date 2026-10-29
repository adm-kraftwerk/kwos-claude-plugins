#!/usr/bin/env node
// The hook entry for `server/teamsGuard.js` (WI 11569154): `pretooluse` on the two ms365 send
// tools. The answer is pure and tested there; this file does the I/O and the ONE question only
// the relay can answer.
//
// ONLY FOR PEOPLE IN A CHANNEL (Steffen, 2026-10-29: "koennen wir das so machen dass diese
// texte nur kommen wenn man im collab ist!?"). So the hint waits for `myJoinedCollabs` -- this
// session must be a member of an OPEN channel, not merely have the plugin. It costs one small
// GET, and only when somebody is about to write to Teams.
//
// WHEN THE ANSWER CANNOT BE HAD, THE HINT STAYS AWAY: a relay that is down must not turn every
// Teams message of the fleet into a reminder, and the send itself is never affected.
//
// NEVER COSTS A TURN. An unreadable payload, a broken import, anything: exit 0 with what we
// have.

import { hookAnswer } from "../server/teamsGuard.js";

async function inCollab(payload) {
  try {
    // The payload names the conversation; the plugin knows it as `config.sessionId`, and the
    // membership is per ADDRESS (`memberHasSession`), so it has to be the same value.
    const session = typeof payload?.session_id === "string" ? payload.session_id.trim() : "";
    if (session !== "") {
      const { config } = await import("../server/config.js");
      config.sessionId = session;
    }
    const collab = await import("../server/collab.js");
    const joined = await collab.myJoinedCollabs();
    return Array.isArray(joined) && joined.length > 0;
  } catch {
    // Not knowing is not a reason to nag: quiet, and the send goes through as before.
    return false;
  }
}

async function main() {
  const event = String(process.argv[2] || "").trim().toLowerCase();
  let payload = {};
  try {
    const raw = await readStdin();
    if (raw.trim() !== "") payload = JSON.parse(raw);
  } catch {
    payload = {};
  }
  const answer = hookAnswer(event, payload, event === "pretooluse" ? await inCollab(payload) : false);
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
