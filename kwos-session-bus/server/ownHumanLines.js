/**
 * The channel lines THIS session sent as the HUMAN's own words.
 *
 * WHY THIS LIST EXISTS (field report 2026-10-20): `collab_send` with `from_human: true` stamps the
 * line `author_kind: "human"`, because the pause counter has to see the human speaking. The receive
 * path (`collab-listen.js`) drops the session's own contributions by `from_session` -- but it has to
 * KEEP `human` lines, or a human typing in this pane's channel view would never reach this session.
 * A relayed line therefore looks exactly like the human's own, and the session read its own
 * sentence a second time and answered it: "Echo meiner eigenen Zeile, kein neues Ereignis".
 *
 * The relay knows the seq it stored, so the send path names it here and the receive path skips it.
 * A set of seqs and not a text comparison: the same words may legitimately be written twice.
 *
 * In-process state, and that is enough: sender and listener are the two halves of ONE MCP server.
 * A restart empties the list, and the worst that follows is one echoed line.
 */
const sent = new Set();

/** How many lines are remembered. The echo arrives within milliseconds; this is pure headroom. */
const LIMIT = 64;

/** Names one line this session relayed as the human's, by the seq the relay answered with. */
export function rememberOwnHumanLine(seq) {
  const n = Number(seq);
  if (!Number.isSafeInteger(n) || n <= 0) return;
  sent.add(n);
  // Oldest out first: `Set` iterates in insertion order.
  while (sent.size > LIMIT) sent.delete(sent.values().next().value);
}

/**
 * Is this the line we relayed ourselves? CONSUMING: a seq is only ever delivered once, and a
 * leftover entry would silently swallow a later frame that happens to reuse the number.
 */
export function takeOwnHumanLine(seq) {
  const n = Number(seq);
  if (!Number.isSafeInteger(n) || n <= 0) return false;
  return sent.delete(n);
}

/** Only for tests: the module is a singleton, and a test needs a clean slate. */
export function forgetOwnHumanLines() {
  sent.clear();
}
