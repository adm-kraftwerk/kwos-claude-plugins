// Where a message for another person goes (WI 11569154, measured 2026-10-29).
//
// WHAT HAPPENED. A session sent a workitem update into a Teams chat. The order was the
// ordinary one -- "sag Steffen, dass ..." -- and the agent took the tool that exists for
// writing to a person. The system prompt said otherwise, but it is read at session start,
// and this tool was picked an hour later.
//
// A NUDGE, NOT A GATE (Steffen, 2026-10-29: "wir wollen ja nicht stoppen. das fuer teams
// soll ja verfuegbar sein. wir wollen doch lediglich drauf aufmerksam machen, dass das
// andere vielleicht besser ist"). So this is PostToolUse with `additionalContext`: the send
// goes through, the message is delivered, and the model is told -- at the moment it just
// used the tool -- which way the next one should take. A `deny` here would have made Teams
// unreachable for the external recipient and the announcement, which are the person's own
// acts.
//
// WHY IN THIS PLUGIN. The channel exists exactly where this plugin runs -- every session
// except the direct path. A session without the channel is never told to use it.
//
// Pure on purpose: the answer is text, and its test needs no harness
// (`tests/teamsGuard.test.js`).

/** The two ms365 tools that write to a chat or a channel. */
export const MS365_SEND = /^mcp__ms365__(send-chat-message|send-channel-message)$/;

/**
 * What the model reads right after such a send.
 *
 * It says the message is out (no illusion about undoing it), names the way for the next one,
 * and leaves the human's own use untouched -- an external recipient is a Teams message, and
 * that is not this hook's business.
 */
export const NOTE =
  "Fuer ein Update an eine andere Person oder deren Agenten ist der Kanal der bessere Weg " +
  "(collab_send): dort liest auch ihr Agent mit, hier nicht. Diese Zeile ist raus -- beim " +
  "naechsten Mal in den Kanal; geht es an einen Menschen ausserhalb der Zusammenarbeit " +
  "(externer Empfaenger, Ankuendigung), bleibt Teams richtig.";

/**
 * What the hook prints for one event, or `null` (nothing to say).
 *
 * `event` is the hook name in lower case, the spelling `hooks.json` passes on the command line.
 */
export function hookAnswer(event, payload) {
  if (event !== "posttooluse") return null;
  const name = typeof payload?.tool_name === "string" ? payload.tool_name : "";
  if (!MS365_SEND.test(name)) return null;
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: NOTE } };
}
