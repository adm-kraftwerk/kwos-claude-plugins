// Where a message for another person goes (WI 11569154, measured 2026-10-29).
//
// WHAT HAPPENED. A session sent a workitem update into a Teams chat. The order was the
// ordinary one -- "sag Steffen, dass ..." -- and the agent took the tool that exists for
// writing to a person. The system prompt said otherwise, but it is read at session start,
// and this tool was picked an hour later.
//
// A HINT BEFORE THE CALL, NOT A GATE AND NOT A REPRIMAND (Steffen, 2026-10-29: "wir muessen
// einen weg finden vorher drauf hinzuweisen dass das tool das falsche ist … so eine info
// hinterher im sinne von 'du dummi das war falsch' das brauchen wir nicht"). Teams stays
// available -- for a human outside the collaboration it is the right tool.
//
// MEASURED, NOT ASSUMED (2026-10-29, client 2.1.312): a PreToolUse hook may return
// `hookSpecificOutput.additionalContext` WITHOUT any `permissionDecision`. The client's own
// schema carries the field beside `permissionDecision`/`updatedInput`, and a probe session
// read the injected marker and still performed the tool call. That is the one shape that
// talks to the model BEFORE the call and decides nothing.
//
// WHY IN THIS PLUGIN. The channel exists exactly where this plugin runs -- every session
// except the direct path. A session without the channel is never told to use it.
//
// Pure on purpose: the answer is text, and its test needs no harness
// (`tests/teamsGuard.test.js`).

/**
 * The two ms365 tools that write to a chat or a channel.
 *
 * THE NAME HAS A PLUGIN SEGMENT IN THE FLEET (measured 2026-10-30, client 2.1.312): the ms365
 * server is declared in `kraftwerkos/.mcp.json`, so the tool is
 * `mcp__plugin_kraftwerkos_ms365__send-chat-message`, not `mcp__ms365__...` -- the client scopes
 * a plugin-bundled MCP server's segment by plugin name, and a matcher written against the bare
 * server key never fires (hooks docs, "Match MCP tools"). The first version of this file used
 * the bare form, which would have made the whole hook silent.
 *
 * The bare form stays valid: a user-scope or project-scope `ms365` server keeps it, and both
 * spellings mean the same tool.
 */
export const MS365_SEND = /^mcp__(?:plugin_[a-z0-9-]+_)?ms365__(?:send-chat-message|send-channel-message)$/;

/**
 * What the model reads right before such a send.
 *
 * It names the better way for an update to another person or their agent, and it says in the
 * same breath when Teams IS right -- otherwise the hint would push an announcement or a
 * message to a customer away from the tool that belongs to it.
 */
export const HINT =
  "Hinweis vor dem Senden: fuer ein Update an eine andere Person oder deren Agenten ist der " +
  "kwcollab-Kanal der bessere Weg (collab_send) -- dort liest auch ihr Agent mit, in einer " +
  "Teams-Nachricht nicht. Geht es an einen Menschen ausserhalb der Zusammenarbeit (externer " +
  "Empfaenger, Ankuendigung, Zustellnachweis), ist Teams richtig; dann sende wie geplant.";

/**
 * What the hook prints for one event, or `null` (nothing to say).
 *
 * `event` is the hook name in lower case, the spelling `hooks.json` passes on the command line.
 * `inCollab` says whether THIS session is a member of an open channel -- the hook asks the relay
 * (`hooks/teams-guard.js`, `myJoinedCollabs`) and hands the answer in, so this function stays
 * pure. Without it there is no hint: somebody who is not in a channel must not be pointed at
 * one.
 *
 * No `permissionDecision` is ever returned: the call always goes through.
 */
export function hookAnswer(event, payload, inCollab = false) {
  if (event !== "pretooluse" || inCollab !== true) return null;
  const name = typeof payload?.tool_name === "string" ? payload.tool_name : "";
  if (!MS365_SEND.test(name)) return null;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: HINT } };
}
