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
import { config, ensureSessionId, refreshSessionId } from "./config.js";
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
 */
export const COLLAB_POLL_MS = Number(process.env.KWOS_COLLAB_POLL_MS || 15_000);

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
  let sessionAbort = new AbortController();
  const stop = () => { stopping = true; sessionAbort.abort(); signalEnded(); };
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

  async function poll() {
    if (stopping) return;
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
    for (const [id, entry] of [...open]) {
      if (!wanted.has(id)) { entry.controller.abort(); open.delete(id); }
    }
    for (const c of joined) {
      if (open.has(c.collab_id)) continue;
      const controller = new AbortController();
      open.set(c.collab_id, { controller });
      const members = Array.isArray(c.members) ? c.members : [];
      log.info("Collab-Kanal verbunden.", { collabId: c.collab_id, workitem: c.workitem });
      runSseReceiver(
        (raw) => {
          const line = frameToLine(raw, { members, selfSessionId: config.sessionId, collabId: c.collab_id });
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
    closeAll();
    sessionAbort = new AbortController();
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
