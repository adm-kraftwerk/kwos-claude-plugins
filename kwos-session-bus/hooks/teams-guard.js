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

import { MS365_SEND, hookAnswer } from "../server/teamsGuard.js";

/**
 * How long the membership question may take before the hook gives up.
 *
 * THE HOOK SITS IN FRONT OF A TOOL CALL, so its cost is the caller's cost: a relay that accepts
 * the connection and then says nothing would hold a Teams send for the whole hook timeout (5 s).
 * This budget is spent once, quietly; what it buys is that the send is never held longer than a
 * second and a half for a hint nobody asked for (token helper and request together).
 */
export const MEMBERSHIP_BUDGET_MS = 1_500;

async function inCollab(payload) {
  let timer = null;
  try {
    // The payload names the conversation; the plugin knows it as `config.sessionId`, and the
    // membership is per ADDRESS (`memberHasSession`), so it has to be the same value.
    const session = typeof payload?.session_id === "string" ? payload.session_id.trim() : "";
    if (session !== "") {
      const { config } = await import("../server/config.js");
      config.sessionId = session;
    }
    const collab = await import("../server/collab.js");
    // THE RACE IS THE GUARANTEE: `call()` has no timeout of its own, so a hanging request would
    // otherwise run into the harness timeout. `null` means "not known", and not known is quiet.
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), MEMBERSHIP_BUDGET_MS);
      // Unref'd: this promise must not be what keeps the hook process alive for a second after
      // it has already answered.
      if (typeof timer.unref === "function") timer.unref();
    });
    const joined = await Promise.race([collab.myJoinedCollabs(), deadline]);
    return Array.isArray(joined) && joined.length > 0;
  } catch {
    // Not knowing is not a reason to nag: quiet, and the send goes through as before.
    return false;
  } finally {
    if (timer !== null) clearTimeout(timer);
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
  // NOTHING TO SAY, NO NETWORK: the relay is asked only for the event and the two tools this
  // hook exists for. A widened matcher in `hooks.json` must not cost every tool call a round trip.
  const name = typeof payload?.tool_name === "string" ? payload.tool_name : "";
  if (event !== "pretooluse" || !MS365_SEND.test(name)) return;
  const answer = hookAnswer(event, payload, await inCollab(payload));
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
