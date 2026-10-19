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

// The measured line budget, from the sibling monitor: Claude Code cuts every monitor line at 500
// CHARACTERS and cuts at the line END (WI 11075502, measured), so the line has to cap itself and
// its own truncation marker has to survive. Imported rather than repeated -- a second copy of a
// measured number is a second number that can drift.
import { MAX_LINE_CHARS } from "./listen.js";

export const COLLAB_LINE_PREFIX = "[kwcollab";

// The whole point of the prefix: the reader (Claude AND the human in the transcript) must see, in
// one glance, WHO wrote and whether that was a person or their agent. The kwremote line carries
// neither -- it is always the owner.
export const COLLAB_KINDS = ["human", "claude", "system"];

// Below this, splitting stops being a readable message and becomes noise (one short fragment per
// line). Such a message falls back to an honest truncation marker instead.
const MIN_CHUNK_CHARS = 32;

/** Short id for the line: the first UUID group is enough to tell two channels apart. */
export function collabShortId(collabId) {
  return String(collabId || "").split("-")[0];
}

/** The framing every line of one message carries: channel, sender, kind. */
function headOf(collabId, from, kind) {
  const who = typeof from === "string" && from.trim() ? from.trim() : "?";
  const authorKind = COLLAB_KINDS.includes(kind) ? kind : "claude";
  return `${COLLAB_LINE_PREFIX} ${collabShortId(collabId)} | ${who} | ${authorKind}] `;
}

/**
 * The text of one message. A message with an attachment and no text is a valid case (a screenshot
 * of the failure speaks for itself), so the body names the attachment instead of being empty.
 *
 * Control characters are flattened to a space: one stdout line is one notification, and only a
 * line starting with COLLAB_LINE_PREFIX is framed as FOREIGN DATA for the reader. A raw newline
 * inside the text would start a second line without that framing.
 */
function bodyOf(text, attachmentId) {
  let body = typeof text === "string" ? text.trim() : "";
  if (!body && attachmentId) body = `[Anhang: mit collab_get_attachment ${attachmentId} abrufbar]`;
  return body.replace(/[\u0000-\u001f\u007f]+/g, " ");
}

/** `str` cut to `limit` UTF-16 units, never leaving half of a surrogate pair behind. */
function cutAt(str, limit) {
  if (str.length <= limit) return str;
  let end = Math.max(0, limit);
  const code = str.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return str.slice(0, end);
}

/**
 * The body as parts of at most `capacity` UTF-16 units, or null when the budget is too small to
 * split into readable parts. Split on code point boundaries (Array.from), so a multi-byte character
 * is never cut in half; a trailing backslash moves to the next part, so an escape sequence stays
 * intact.
 */
function splitBody(body, capacity) {
  if (capacity < MIN_CHUNK_CHARS) return null;
  const parts = [];
  let current = "";
  for (const cp of Array.from(body)) {
    if (current.length > 0 && current.length + cp.length > capacity) {
      if (current.endsWith("\\")) {
        parts.push(current.slice(0, -1));
        current = "\\";
      } else {
        parts.push(current);
        current = "";
      }
    }
    current += cp;
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * One channel message as the lines the monitor prints. Short messages stay one line; a long one is
 * SPLIT across several lines instead of being cut -- a seed and a move were lost to the cut, and
 * the marker did not even say where the rest was.
 *
 * Every line repeats the head on purpose: the prompt fragment in the litellm repo frames lines
 * STARTING WITH "[kwcollab" as foreign data, so a continuation line without the head would reach
 * the session as an unframed instruction. "(i/n)" tells the reader that the lines belong together
 * even when the harness shows them as separate notifications (the writer keeps them apart, s.
 * LINE_SPACING_MS in listen.js).
 *
 * Cutting is only the last resort, for a budget too small for any honest part; its marker then says
 * that the rest is GONE. It deliberately does not point at `get_message`: that tool reads
 * /v1/sessions/{id}/messages, and channel messages are not in the session's history.
 */
export function collabLines({ collabId, from, kind, text, attachmentId, maxChars = MAX_LINE_CHARS }) {
  const head = headOf(collabId, from, kind);
  const body = bodyOf(text, attachmentId);
  if (head.length + body.length <= maxChars) return [head + body];
  // Reserve the widest suffix this body could need; the actual part count is never larger, so no
  // rendered line can exceed the budget. A part is at least MIN_CHUNK_CHARS long, which bounds the
  // number of parts and with it the digits in "(i/n)".
  const maxParts = Math.max(1, Math.ceil(body.length / MIN_CHUNK_CHARS));
  const suffix = `(${maxParts}/${maxParts}) `.length;
  const parts = splitBody(body, maxChars - head.length - suffix);
  if (!parts) return [collabLine({ collabId, from, kind, text, attachmentId, maxChars })];
  return parts.map((part, i) => `${head}(${i + 1}/${parts.length}) ${part}`);
}

/**
 * One channel line, cut to `maxChars`. A message with an attachment and no text is a valid case (a
 * screenshot of the failure speaks for itself), so the line names the attachment instead of ending
 * in a colon with nothing after it.
 *
 * `maxChars` bounds the WHOLE line, not the text (review finding 2026-10-16): the prefix, the
 * channel id, the sender and the kind are part of what the harness counts. Capping only the text
 * put the line at ~540-560 characters, and the cut lands at the line end -- exactly where the
 * truncation marker sits, so a truncated message arrived looking complete.
 *
 * Used directly for short messages and as the last resort of `collabLines`; a long message normally
 * becomes several lines there instead of losing its tail here.
 */
export function collabLine({ collabId, from, kind, text, attachmentId, maxChars = MAX_LINE_CHARS }) {
  const head = headOf(collabId, from, kind);
  const body = bodyOf(text, attachmentId);
  if (head.length + body.length <= maxChars) return head + body;
  // Reserve the marker's own length, and slice at the end as the hard guarantee -- the sender name
  // comes from the relay and its length is not ours to trust (same two steps as formatLine).
  const marker = `… [gekürzt, Rest fehlt: ${body.length} Zeichen gesamt]`;
  // If even the honest marker does not fit, the hard cut must not swallow it.
  const chosen = marker.length < maxChars ? marker : "… [gekürzt]";
  return `${cutAt(`${head}${body}`, maxChars - chosen.length)}${chosen}`;
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
