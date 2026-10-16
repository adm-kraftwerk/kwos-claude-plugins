#!/usr/bin/env node
// kwcollab monitor (WI 11482928) -- the piece that puts a foreign message into THIS session.
//
// Started at session start like the session-bus listener (monitors/monitors.json), and it stays
// idle until this session joins a channel: being in a collab is a fact on the relay (the member
// row carries the session id), so the monitor ASKS instead of guessing locally. That is also why
// it polls: a channel can be joined while the session is already running, and Claude Code cannot
// start a monitor mid-session reliably (the documented way, `when: "on-skill-invoke:<skill>`, was
// not dependable in practice) -- so the monitor is always there and picks the channel up.
//
// One line per message on stdout, diagnostics on stderr (the convention of this plugin, s.
// listen.js). The line format lives in collabLine.js -- it is the contract with the prompt
// fragment that tells Claude these lines are FOREIGN DATA.
//
// Deliberately NOT fed back: anything this session itself sent. The relay replays up to 500
// backlog frames on reconnect (relay/server.js), and our own messages are in that backlog -- a
// monitor that hands them back to Claude would answer its own message, forever.

import { fileURLToPath } from "node:url";
import { config, ensureSessionId, refreshSessionId, readCheckInterval } from "./config.js";
import { log } from "./log.js";
import { runSseReceiver } from "./sse-receiver.js";
import { createLineWriter } from "./listen.js";
import { collabLine, collabClosedLine, senderName } from "./collabLine.js";
import * as collab from "./collab.js";

// How often the monitor asks which channels this session is in. Short enough that joining feels
// immediate, long enough that an idle session does not hammer the relay: one small GET.
/**
 * How often the monitor asks which channels this session is in.
 *
 * Short enough that joining feels immediate, long enough that an idle session does not hammer the
 * relay: one small GET (`SELECT … WHERE subject = $1`), and the plugin runs in EVERY session since
 * 2026-10-15. At a few hundred concurrent sessions that is single-digit requests per second --
 * cheap, but it is a cost that lasts for the whole life of every session, so it can be raised
 * without a new build: `KWOS_COLLAB_POLL_MS`.
 *
 * Validated like the marker interval (readCheckInterval): a typo must not become the interval --
 * `setInterval(fn, NaN)` fires every millisecond, and this one is a request against the relay in
 * every session of the fleet (review finding 2026-10-16).
 */
export const COLLAB_POLL_MS = readCheckInterval(process.env.KWOS_COLLAB_POLL_MS, 15_000);

/**
 * One SSE frame -> the line to print, or null when it must NOT be printed.
 *
 * Null for our own messages (see the file header) and for anything unreadable: a monitor that
 * prints a guess would put invented words into the session.
 */
export function frameToLine(raw, { members = [], selfSessionId = null, collabId = null } = {}) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return null; }
  if (!msg || typeof msg !== "object") return null;
  // The channel's own lifecycle event (relay: `event: closed`, data { collab_id }).
  if (!msg.seq) return msg.collab_id ? collabClosedLine(msg.collab_id) : null;
  if (selfSessionId && msg.from_session === selfSessionId) return null;
  // A message without text is a valid case (a screenshot speaks for itself) -- collabLine names
  // the attachment then.
  return collabLine({
    collabId: msg.collab_id || collabId,
    from: senderName(msg, members),
    kind: msg.author_kind,
    text: msg.text,
    attachmentId: msg.attachment_id,
  });
}

async function main() {
  await ensureSessionId();

  let stopping = false;
  let signalEnded;
  const ended = new Promise((resolve) => { signalEnded = resolve; });
  // No session-wide AbortController here: every stream has its own controller in `open`, and
  // `closeAll()` is what ends them (on a /clear re-bind and on the way out). A second, unused
  // controller would only look like it did something.
  const stop = () => { stopping = true; signalEnded(); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const writeLine = createLineWriter(process.stdout);
  // One stream per channel, keyed by collab id. Kept across polls, so a channel we are already in
  // is not re-opened every 15 s (that would replay the backlog again and again).
  const open = new Map();

  const closeAll = () => {
    for (const [id, entry] of open) { entry.controller.abort(); }
    open.clear();
  };

  // The channels THIS session holds on the relay, as of the last poll that reached the relay. Kept
  // next to `open` because a channel can be joined a moment before its stream is up: a `/clear` in
  // that window finds an empty `open`, and after the change the poll cannot recover it either (the
  // member row still names the OLD session id, so `myJoinedCollabs` reports no channel at all) --
  // the channel would be silently gone. Not cleared on a failed poll: what this session held a
  // minute ago is a better answer than nothing.
  let lastJoined = new Set();

  // One poll at a time, and a second caller shares the one in flight instead of starting another
  // (review finding 2026-10-16): the interval and the /clear re-bind both call this, and two polls
  // running side by side would each find `open` empty for a channel and each open a stream for it --
  // every line of that channel delivered twice. A poll that overruns its interval (a slow relay;
  // `call()` sets no timeout) is exactly the case that produces that overlap.
  let inflight = null;
  function poll() {
    if (stopping) return Promise.resolve();
    if (!inflight) inflight = pollOnce().finally(() => { inflight = null; });
    return inflight;
  }

  async function pollOnce() {
    let joined = [];
    try {
      joined = await collab.myJoinedCollabs();
    } catch (err) {
      // Not fatal and not silent: no channel stream is opened this round, the next poll tries
      // again. A session without a relay connection simply has no collab.
      log.error("Collab-Liste nicht abrufbar.", { error: String(err) });
      return;
    }
    const wanted = new Set(joined.map((c) => c.collab_id));
    lastJoined = wanted;
    for (const [id, entry] of [...open]) {
      if (!wanted.has(id)) { entry.controller.abort(); open.delete(id); }
    }
    for (const c of joined) {
      const members = Array.isArray(c.members) ? c.members : [];
      const existing = open.get(c.collab_id);
      if (existing) {
        // Same stream, fresh names: the member list is what turns an opaque login into a display
        // name, and it grows while the channel is open (review finding 2026-10-16 -- the list used
        // to be frozen at the moment the stream was opened, so later joiners stayed logins).
        existing.members = members;
        continue;
      }
      const controller = new AbortController();
      const entry = { controller, members };
      open.set(c.collab_id, entry);
      log.info("Collab-Kanal verbunden.", { collabId: c.collab_id, workitem: c.workitem });
      runSseReceiver(
        (raw) => {
          const line = frameToLine(raw, {
            members: entry.members, selfSessionId: config.sessionId, collabId: c.collab_id,
          });
          if (line) writeLine(line);
        },
        { signal: controller.signal, url: collab.collabEventsUrl(c.collab_id) }
      ).catch((err) => {
        if (!controller.signal.aborted) log.error("Collab-Empfang beendet.", { error: String(err) });
      });
    }
  }

  // `/clear` and `--resume` hand out a new session id inside this process: the streams belong to
  // the OLD one and would stay deaf. Same rule as the session listener (listen.js).
  //
  // UNREF'D, and that is a review finding and not a detail (Kai, 2026-10-16, on the re-bind timer
  // in `index.js`): an open stdin already keeps this process up for as long as the session lives,
  // so a timer that is NOT unref'd does not hold anything together -- it only decides what happens
  // after the session is gone. The orphan then keeps polling the relay every 15 s for a session
  // nobody is in any more. Measured on the sibling timer: 47 ms to exit with it unref'd, still
  // alive 10 s later without.
  const watch = setInterval(async () => {
    if (stopping) return;
    let changed = false;
    try {
      changed = await refreshSessionId();
    } catch (err) {
      log.error("Session-ID konnte nicht neu gelesen werden.", { error: String(err) });
    }
    if (!changed) return;
    // The streams belonged to the OLD id -- and so does the member row on the relay: after /clear
    // this session is joined to NOTHING until it says so again (`myJoinedCollabs` filters on the
    // member row's session id, s. collab.js). That is exactly what the relay's repeat accept is for:
    // it MOVES the row to the new id instead of answering "already joined" (review finding Kai,
    // 2026-10-16). Without this call the channel was gone for the client after every /clear -- the
    // tools refused and this monitor let its streams go.
    //
    // Only the channels this session ACTUALLY held are re-accepted, never "everything my login is
    // joined to": a second window may be in the same channel, and an accept from here would move the
    // membership away from it. `lastJoined` is in here for the channel that was joined but whose
    // stream had not come up yet (see above) -- that one is this session's too, or the poll would
    // not have reported it.
    const was = [...new Set([...open.keys(), ...lastJoined])];
    closeAll();
    for (const id of was) {
      try {
        await collab.acceptCollab(id);
      } catch (err) {
        // Not fatal (the next poll simply finds no channel), but LOUD: this is the one failure a
        // person cannot see for themselves -- the channel just looks empty.
        log.error("Kanal nach dem Session-Wechsel nicht neu angenommen.", { collabId: id, error: String(err) });
      }
    }
    await poll();
  }, config.sessionIdCheckMs);
  watch.unref();

  try {
    await poll();
    const pollTimer = setInterval(() => { poll().catch(() => {}); }, COLLAB_POLL_MS);
    pollTimer.unref();
    await ended;
  } finally {
    clearInterval(watch);
    closeAll();
    await writeLine.flush();
  }
}

// Guard as in index.js/listen.js: an `import` from a test must not open a real SSE connection.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    log.error("Unerwarteter Fehler im Collab-Listener.", { error: String(err) });
    process.exit(1);
  });
}
