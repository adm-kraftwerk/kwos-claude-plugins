// The ONE spelling of a kwcollab monitor line (WI 11482928). Pure, no I/O -- node --test can
// exercise it without a relay or a session.
//
// It is a contract with two other places, and that is why it is a module of its own rather than a
// template string inside the listener:
//   * the prompt fragment in the litellm repo (bootstrap/kwos-collab-system-prompt.md) tells Claude
//     that lines starting with "[kwcollab" are FOREIGN DATA, not the owner's instruction;
//   * relay/lib.js::collabMonitorLine pins the same prefix on the server side for its own tests.
// If the prefix drifts, the fragment stops matching the lines and kwcollab messages silently get
// treated like kwremote ones -- which is the one mistake this feature must not make.

export const COLLAB_LINE_PREFIX = "[kwcollab";

// The whole point of the prefix: the reader (Claude AND the human in the transcript) must see, in
// one glance, WHO wrote and whether that was a person or their agent. The kwremote line carries
// neither -- it is always the owner.
export const COLLAB_KINDS = ["human", "claude", "system"];

/** Short id for the line: the first UUID group is enough to tell two channels apart. */
export function collabShortId(collabId) {
  return String(collabId || "").split("-")[0];
}

/**
 * One channel line. A message with an attachment and no text is a valid case (a screenshot of the
 * failure speaks for itself), so the line names the attachment instead of ending in a colon with
 * nothing after it.
 */
export function collabLine({ collabId, from, kind, text, attachmentId, maxChars = 500 }) {
  const who = typeof from === "string" && from.trim() ? from.trim() : "?";
  const authorKind = COLLAB_KINDS.includes(kind) ? kind : "claude";
  let body = typeof text === "string" ? text.trim() : "";
  if (!body && attachmentId) body = `[Anhang: mit collab_get_attachment ${attachmentId} abrufbar]`;
  if (body.length > maxChars) body = `${body.slice(0, maxChars)}… [gekürzt, ${body.length} Zeichen]`;
  return `${COLLAB_LINE_PREFIX} ${collabShortId(collabId)} | ${who} | ${authorKind}] ${body}`;
}

/**
 * The channel is gone (relay: `event: closed`, sent when somebody closes it). The session has to
 * hear that: a channel that quietly stops delivering looks like nobody is writing.
 */
export function collabClosedLine(collabId) {
  return `${COLLAB_LINE_PREFIX} ${collabShortId(collabId)} | system] Kanal beendet -- Protokoll auf dem Server geloescht.`;
}

/**
 * The readable name of the sender: the display name once the person has joined (XID `name`), the
 * login before that. A channel line that shows an opaque login is legible only to machines.
 */
export function senderName(message, members) {
  const subject = message?.from_subject;
  if (subject === "relay") return "kwcollab";
  const m = (members || []).find((x) => x.subject === subject);
  return m?.display_name || subject || "?";
}
