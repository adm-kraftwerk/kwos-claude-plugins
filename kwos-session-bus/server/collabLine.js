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
 *
 * The predicate COERCES first and is byte-for-byte the relay's pinned copy
 * (relay/lib.js::collabMonitorLine): a seq may arrive as a number OR as a string, and a mixed fleet
 * means the two sides must read it the same way. Without the coercion a seq of "12" renders ":12"
 * on the relay and drops the address here -- the reader would then have no way to fetch a line it
 * could perfectly well fetch. `Number.isSafeInteger` (not `isInteger`) keeps a value that cannot be
 * a real sequence number -- 1e21, NaN, Infinity -- out of the head.
 */
function collabHead({ collabId, seq, who, kind, at }) {
  const n = Number(seq);
  const seqPart = Number.isSafeInteger(n) && n > 0 ? `:${n}` : "";
  const clock = collabClock(at);
  return `${COLLAB_LINE_PREFIX} ${collabShortId(collabId)}${seqPart} | ${who} | ${kind}${clock === "" ? "" : ` ${clock}`}] `;
}

/**
 * The moment a line was written, in the one format JavaScript prints for a UTC instant:
 * `2026-10-28T10:32:05Z` (`Date#toISOString` without the milliseconds), or "".
 *
 * WHY IT IS THERE (WI 11569154): the diagnosis report could not order its own observations --
 * monitor lines carried no time at all, and two of them arrived in ONE delivery. The relay stores
 * `created_at` with every line, so the moment the sentence was written is known.
 *
 * UTC, NOT THE LOCAL TIME (2026-10-28). A channel is shared across time zones: the same sentence
 * would carry a different clock in every participant's transcript, and a finding that says "at
 * 10:32 nobody had answered" would be wrong for everyone else. The relay, the database, the server
 * log and the ISO form JavaScript writes are all UTC, so a session log can be put next to them
 * without arithmetic -- and the date is part of it, which a bare clock is not.
 *
 * Unreadable or absent yields "" -- a line without a time, never an invented one (an older relay
 * sends no `created_at`).
 */
export function collabClock(at) {
  if (at === null || at === undefined || at === "") return "";
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  // Seconds, not milliseconds: this is read by a person, and the relay's own timestamps carry no
  // more precision either.
  return `${d.toISOString().slice(0, 19)}Z`;
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
export function collabLine({ collabId, seq = null, from, kind, text, attachmentId, at = null, cap = MONITOR_LINE_MAX, safety = LINE_SAFETY }) {
  const who = typeof from === "string" && from.trim() ? from.trim() : "?";
  const authorKind = COLLAB_KINDS.includes(kind) ? kind : "claude";
  let body = typeof text === "string" ? text.trim() : "";
  if (!body && attachmentId) body = `[Anhang: mit collab_get_attachment ${attachmentId} abrufbar]`;
  const head = collabHead({ collabId, seq, who, kind: authorKind, at });
  return splitIntoLines(head, body, { cap, safety });
}

/**
 * The stream ended (relay: `event: closed`). The session has to hear that: a stream that quietly
 * stops delivering looks like nobody is writing.
 *
 * THE REASON IS THE MESSAGE (measured 2026-10-26, the day this printed a lie). The relay uses the
 * same event for three different things, and only the first one deletes anything:
 *
 *   undefined/"closed" -- somebody closed the channel; the protocol is gone
 *   "access"           -- this member is out (kicked, left, or the workitem is no longer theirs):
 *                         THE CHANNEL LIVES ON, and the next person it helps is somebody else
 *   "check-failed"     -- the renewal could not be answered; the channel was never in question
 *
 * It said "Kanal beendet -- Protokoll auf dem Server geloescht" for all three, so a field report
 * arrived as "was zur hoelle hat den kanal beendet?" about a channel that stood open the whole time
 * with every line intact. A line the harness shows a human must say exactly as much as it knows.
 *
 * No `seq`: this is not a stored message, so there is nothing to fetch and nothing to name. The
 * head therefore keeps its seq-less form.
 */
export function collabClosedLine(collabId, reason = null) {
  const head = `${COLLAB_LINE_PREFIX} ${collabShortId(collabId)} | system]`;
  if (reason === "access") {
    return `${head} Kein Zugriff mehr auf diesen Kanal -- er besteht weiter, diese Sitzung ist nicht mehr Teil davon.`;
  }
  if (reason === "check-failed") {
    return `${head} Die Zugriffspruefung ist fehlgeschlagen -- der Kanal besteht weiter, die Sitzung haengt sich neu an.`;
  }
  return `${head} Kanal beendet -- Protokoll auf dem Server geloescht.`;
}

/**
 * The last path segment of a repository key (`host/path`, s. codeGit.js::repoKey), or null.
 * "Christian @bc" says more than a hash alone: it names the project the speaking agent works in.
 */
function repoShort(repo) {
  const segment = String(repo || "").split("/").filter(Boolean).pop();
  return segment || null;
}

/**
 * The readable name of the sender: the display name once the person has joined (XID `name`), the
 * login before that. A channel line that shows an opaque login is legible only to machines.
 *
 * WHEN THE PERSON IS IN TWICE, THE ADDRESS IS NAMED: the same human with a second session is two
 * working states, and a line that says only "Steffen" leaves the reader guessing which one spoke.
 * An agent knows its repository since it joined (the relay stores it on the agent), so the mark is
 * `Name @<repo-short> #<8 chars>` -- the project says more than the hash, and the hash keeps the
 * address unambiguous when both sessions work in the same project. Without a known repository the
 * mark stays the shorter `Name #<8 chars>`. The mark is ASCII on purpose: the prompt fragment that
 * explains it to the reader is byte-gated, so no separator may need a non-ASCII character.
 */
export function senderName(message, members) {
  const subject = message?.from_subject;
  if (subject === "relay") return "kwcollab";
  const m = (members || []).find((x) => x.subject === subject);
  const name = m?.display_name || subject || "?";
  const agents = Array.isArray(m?.agents) ? m.agents : [];
  const sessions = Array.isArray(m?.sessions) ? m.sessions : [];
  const addresses = agents.length > 0 ? agents : sessions;
  if (addresses.length > 1 && message?.from_session) {
    const short = `#${String(message.from_session).slice(0, 8)}`;
    const repo = agents.length > 0
      ? repoShort(agents.find((a) => a?.session_id === message.from_session)?.repo)
      : null;
    return repo ? `${name} @${repo} ${short}` : `${name} ${short}`;
  }
  return name;
}
