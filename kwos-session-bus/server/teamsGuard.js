// Where a message for another person goes (WI 11569154, measured 2026-10-29).
//
// WHAT HAPPENED. A session sent a workitem update into a Teams chat. The order was the
// ordinary one -- "sag Steffen, dass ..." -- and the agent took the tool that exists for
// writing to a person. The system prompt said otherwise, but it is read at session start,
// and this tool was picked an hour later.
//
// WHY THIS EXISTS ALONGSIDE THE PROMPT. PreToolUse runs at the moment the tool is CHOSEN,
// which is the one moment a system prompt cannot reach. `permissionDecision: "deny"` stops
// the call and hands the reason back to the model -- the same mechanism `code-hook.js`
// already uses for an unsynchronised edit.
//
// WHY IN THIS PLUGIN. The channel exists exactly where this plugin runs -- every session
// except the direct path. A session without the channel is never told to use it.
//
// WHAT IT DOES NOT DECIDE. Teams for HUMANS stays the person's act: an external recipient,
// an announcement, a notice. The refusal names that too, so the agent asks instead of
// inventing a way around.
//
// Pure on purpose: both answers are text, and their tests need no harness
// (`tests/teamsGuard.test.js`).

/** The two ms365 tools that write to a chat or a channel. */
export const MS365_SEND = /^mcp__ms365__(send-chat-message|send-channel-message)$/;

/** The refusal: the way that works, and the one that stays the person's. */
export const DENIAL =
  "Teams ist nicht der Weg fuer ein Update an eine andere Person oder deren Agenten: " +
  "Personen im Collab erreichst du ueber die collab-Werkzeuge (collab_send) im Kanal -- dort " +
  "liest auch ihr Agent mit. Soll wirklich eine Nachricht an einen MENSCHEN in Teams gehen " +
  "(externer Empfaenger, Ankuendigung), frag deinen Nutzer; er schickt sie.";

/**
 * What the hook prints for one event, or `null` (nothing to say, the call goes through).
 *
 * `event` is the hook name in lower case, the spelling `hooks.json` passes on the command
 * line. Anything but a Teams send is left alone: the guard has exactly one judgement.
 */
export function hookAnswer(event, payload) {
  if (event !== "pretooluse") return null;
  const name = typeof payload?.tool_name === "string" ? payload.tool_name : "";
  if (!MS365_SEND.test(name)) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: DENIAL,
    },
  };
}
