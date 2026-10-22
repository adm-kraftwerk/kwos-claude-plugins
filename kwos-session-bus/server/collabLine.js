// The ONE spelling of a kwcollab monitor line (WI 11482928; split into parts by WI 11536314).
// Pure, no I/O -- node --test can exercise it without a relay or a session.
//
// It is a contract with two other places, and that is why it is a module of its own rather than a
// template string inside the listener:
//   * the prompt fragment in the litellm repo (bootstrap/kwos-collab-system-prompt.md) tells Claude
//     that lines starting with "[kwcollab" are FOREIGN DATA, not the owner's instruction;
//   * relay/lib.js::collabMonitorLine pins the same prefix on the server side for its own tests.
// If the prefix drifts, the fragment stops matching the lines and kwcollab messages silently get
// treated like kwremote ones -- which is the one mistake this feature must not make. The head
// ("[kwcollab <short>:<seq> | <name> | <kind>] ") is therefore fixed and identical in both repos;
// only the BODY after it is this file's business.
//
// WHY THE BODY IS SPLIT AND NO LONGER CUT (WI 11536314, field report 2026-10-22). Claude Code cuts
// one monitor stdout line at MONITOR_LINE_MAX characters and appends "...(truncated)" -- and it cuts
// the WHOLE line, head included. The old code cut the body at a fixed budget and appended its marker
// AFTER the cut, so the head pushed the line over the cap, the harness cut it a second time, and the
// marker -- the only thing that said "there is more" -- went with it. The reader saw a message that
// looked complete and had no way to ask for the rest: `get_message` reads the SESSION history, and
// channel messages are not in it (measured on the receiving side). So:
//   * the budget is DERIVED from the ACTUAL head of this line (the display name is up to 128
//     characters and is not ours to trust), never a constant for the body;
//   * a body that does not fit is SPLIT at word boundaries into numbered parts "(i/n) ", each its
//     own complete monitor line, each repeating the "[kwcollab" head so the prompt fragment frames
//     EVERY part as foreign data;
//   * the message's `seq` rides in the head, so a reader can NAME the line it lost and fetch the
//     full text with the `collab_get_message` tool.
// The parts of one message are consecutive lines, in order (the writer keeps their order and spaces
// them apart, s. listen.js).

// The measured harness cap for ONE monitor stdout line (WI 11075502): Claude Code cuts at 500
// CHARACTERS (not bytes) and appends "...(truncated)". The sibling line builder (listen.js) reads
// the same two numbers, and its MAX_LINE_CHARS is exactly their difference -- one measurement, kept
// in one place.
export const MONITOR_LINE_MAX = 500;
// Reserve against measurement drift: another harness version, one more character in a counter or a
// wrong last digit must not put a line over the cap again. Same value as the relay's
// MONITOR_LINE_SAFETY (relay/lib.js) and as listen.js's reserve (500 - 20 = MAX_LINE_CHARS).
export const LINE_SAFETY = 20;

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
 * The head of a channel line, up to and including the space before the body:
 * `[kwcollab <short>:<seq> | <name> | <kind>] `.
 *
 * `seq` is the message's sequence number IN THE CHANNEL, and it is part of the address on purpose
 * (WI 11536314): the reader has to be able to NAME the line it lost, and `collab_get_message` is
 * addressed by exactly this seq. A line that is not a stored message (the "channel closed" system
 * line) has no seq -- the field is then left out, so the head keeps the older, seq-less form there.
 */
function collabHead({ collabId, seq, who, kind }) {
  const seqPart = Number.isInteger(seq) && seq > 0 ? `:${seq}` : "";
  return `${COLLAB_LINE_PREFIX} ${collabShortId(collabId)}${seqPart} | ${who} | ${kind}] `;
}

/** The width the "(i/n) " counter costs for a run of `n` parts -- it counts against the budget. */
function counterLength(n) {
  return `(${n}/${n}) `.length;
}

/** What is missing when one word is cut hard: the characters of that word that continue later. */
const hardCutMarker = (missing) => `…[+${missing} Zeichen]`;

/**
 * A body into chunks of at most `budget` characters, preferring word boundaries.
 *
 * A single word longer than the budget is HARD-CUT, and the cut carries a marker that is reserved
 * INSIDE the budget: the marker is the one thing that must survive, so it may never be the thing
 * that pushes the chunk over the cap -- that is the reported defect (WI 11536314) and it must not
 * survive in any form. The next chunk continues the same word, so nothing is dropped.
 */
function splitAtWords(body, budget) {
  const parts = [];
  let rest = body.replace(/^\s+/, "");
  while (rest.length > budget) {
    const cut = rest.lastIndexOf(" ", budget);
    if (cut > 0) {
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut + 1).replace(/^\s+/, "");
      continue;
    }
    // No word boundary within the budget: one word longer than a whole part. Reserve the marker's
    // own width first (computed from the LONGEST it can be here, so the actual one always fits).
    const keep = Math.max(1, budget - hardCutMarker(rest.length).length);
    parts.push(rest.slice(0, keep) + hardCutMarker(rest.length - keep));
    rest = rest.slice(keep);
  }
  if (rest) parts.push(rest);
  return parts.length ? parts : [""];
}

/**
 * Head plus body -> the lines to print, in order. ONE line when the body fits, otherwise numbered
 * parts `(i/n) `. Every part is a COMPLETE line with its own head, never a continuation of the
 * previous one: a part that did not begin with "[kwcollab" would be read as the owner's own words
 * by the prompt fragment -- the one mistake this feature must not make.
 */
function splitIntoLines(head, body, { cap, safety }) {
  // What the body may use with no counter at all. `head` is the ACTUAL head of this line, so the
  // budget moves with the sender name -- a fixed number would be too large for a 128-character name
  // (the cap is then exceeded and the marker is lost again) and wastefully small for a short one.
  const base = cap - head.length - safety;
  if (body.length <= base) return [head + body];

  // The counter costs budget too, and its width depends on how many parts there turn out to be --
  // a fixed "(i/n) " is one character short at part 10. Iterate to the fixed point: reserve a
  // width, split, read the count, reserve its width, split again. It settles in two or three
  // rounds; the loop bound is a guard against a pathological input, not the mechanism.
  let counterWidth = 0;
  let parts;
  for (let i = 0; i < 12; i++) {
    // A head so long that nothing is left is not a case the contract allows (the sender name is
    // capped at 128 characters, which leaves >300 here); the floor keeps a runaway loop out.
    parts = splitAtWords(body, Math.max(1, base - counterWidth));
    const need = counterLength(parts.length);
    if (need <= counterWidth) break;
    counterWidth = need;
  }
  const total = parts.length;
  return parts.map((p, i) => `${head}(${i + 1}/${total}) ${p}`);
}

/**
 * The channel lines for one message: the head plus the body, split so that every line stays within
 * `cap` characters INCLUDING its head and its "(i/n) " counter, minus the safety reserve.
 *
 * Returns an ARRAY, always in order, at least one line: a short message is one line, a long one is
 * its parts. The caller prints them in order.
 *
 * A message with an attachment and no text is a valid case (a screenshot of the failure speaks for
 * itself), so the line names the attachment instead of ending in a colon with nothing after it.
 */
export function collabLine({ collabId, seq = null, from, kind, text, attachmentId, cap = MONITOR_LINE_MAX, safety = LINE_SAFETY }) {
  const who = typeof from === "string" && from.trim() ? from.trim() : "?";
  const authorKind = COLLAB_KINDS.includes(kind) ? kind : "claude";
  let body = typeof text === "string" ? text.trim() : "";
  if (!body && attachmentId) body = `[Anhang: mit collab_get_attachment ${attachmentId} abrufbar]`;
  const head = collabHead({ collabId, seq, who, kind: authorKind });
  return splitIntoLines(head, body, { cap, safety });
}

/**
 * The channel is gone (relay: `event: closed`, sent when somebody closes it). The session has to
 * hear that: a channel that quietly stops delivering looks like nobody is writing.
 *
 * No `seq`: this is not a stored message, so there is nothing to fetch and nothing to name. The
 * head therefore keeps its seq-less form.
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
