#!/usr/bin/env node
// The kwcollab receive path (WI 11482928) -- the piece that puts a foreign message into THIS
// session.
//
// Started by the ONE monitor process every session with this plugin has (server/monitor.js), and
// it stays idle until this session joins a channel: being in a collab is a fact on the relay (the
// member row carries the session id), so the monitor ASKS instead of guessing locally. That is
// also why it polls: a channel can be joined while the session is already running, and Claude Code
// cannot start a monitor mid-session reliably (the documented way,
// `when: "on-skill-invoke:<skill>`, was not dependable in practice) -- so the monitor is always
// there and picks the channel up.
//
// WHY IT IS NO LONGER ITS OWN ENTRY IN monitors/monitors.json (2026-10-19, WI 11506447): a monitor
// entry is a PROMISE the harness makes to the session -- Claude Code starts it at session start (a
// missing `when` and `"always"` mean the same thing) and announces it by its DESCRIPTION, before
// the process gets any chance to say no. The gate below therefore came too late: this plugin is
// enabled in every `--kwremote` session (a fleet feature, s. bootstrap/kwclaude-gw.sh in the
// litellm repo), so the description naming kwcollab and its workitem was announced in every such
// session of the fleet, and the monitor exited a moment later. The fleet saw an unreleased
// feature's name and the model reacted to that line. Where the channel is not released, nothing
// about it may be announced: this path rides along in the listener those sessions already have,
// and `collabReleased` decides whether it is started at all.
//
// One line per message on stdout, diagnostics on stderr (the convention of this plugin, s.
// listen.js). The line format lives in collabLine.js -- it is the contract with the prompt
// fragment that tells Claude these lines are FOREIGN DATA.
//
// Deliberately NOT fed back: anything this session's AGENT itself sent. The relay replays up to 500
// backlog frames on reconnect (relay/server.js), and our own messages are in that backlog -- a
// monitor that hands them back to Claude would answer its own message, forever.
//
// AND ONLY THE AGENT's, not everything that carries this session's id: a HUMAN message written in
// the channel view of this very pane comes back stamped with this session (it went through this
// server), and it is exactly the message the session is supposed to receive. Without the
// `author_kind` in the filter below, a person cannot reach their own session through its channel at
// all -- measured 2026-10-19 (tgoebel), the one way the channel is actually used.

import { fileURLToPath } from "node:url";
import { fstatSync } from "node:fs";
import { config, ensureSessionId, refreshSessionId, readCheckInterval } from "./config.js";
import { log } from "./log.js";
import { runSseReceiver } from "./sse-receiver.js";
import { readCursor, rememberCursor } from "./collabCursor.js";
import { createLineWriter } from "./listen.js";
import { collabLine, collabClosedLine, senderName } from "./collabLine.js";
import * as collab from "./collab.js";
import { codeServing as defaultCodeServing } from "./codeMonitor.js";

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
 * Is the channel released on THIS machine? The launcher answers that question once and exports the
 * answer as `KWOS_COLLAB_CANARY` ("explicit switch > remembered ring > OFF" --
 * bootstrap/kwclaude-gw.sh), so kwterm's server, the TUI and this monitor read the SAME answer
 * instead of three guesses.
 *
 * WHY THE MONITOR ASKS AT ALL (review finding 2026-10-16): without this the plugin would carry the
 * receive path of the channel into EVERY `--kwremote` session of the fleet -- the monitor would
 * poll `GET /v1/collabs` every 15 s for a channel that no interface offers and no human asked for.
 * Worse, the prompt fragment that marks `[kwcollab …]` lines as FOREIGN DATA is appended by the
 * launcher under the same switch -- so outside the ring, lines from another person's agent would
 * arrive WITHOUT the framing that tells the session to treat them as data. The ring decides the
 * channel; it has to decide its receive path too.
 *
 * Anything else counts as OFF, including unset: the launcher in the field today does not export
 * the variable yet, and a feature that switches itself on is not a release.
 *
 * The spellings are the launcher's own (bootstrap/kwclaude-gw.sh, `kwos_collab_released`): `1`,
 * `true` or `yes`, case-insensitive and whitespace-stripped, and `KWOS_NO_COLLAB` beats everything
 * (tested as "non-empty", the way `[ -n … ]` does it). The launcher normalises what it exports to
 * `1`/`0`, so this is the same answer by the same rule -- a hand-set value just behaves like a
 * launcher answer instead of needing one.
 */
export function collabReleased(env = process.env) {
  if (String(env?.KWOS_NO_COLLAB ?? "") !== "") return false;
  const v = String(env?.KWOS_COLLAB_CANARY ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Is stdin a CHANNEL that the session really holds -- a pipe or a socket?
 *
 * Only then may its EOF mean "the session is over" (see the stdin block in `startCollabListener`).
 * Claude Code starts a plugin monitor with `stdin = /dev/null` (measured 2026-10-19: the spawn
 * line in `ps` ends in `< /dev/null`), and reading that gives EOF immediately -- so a binding that
 * stopped the receive path on `end` stopped it milliseconds after it had opened its stream. The fd
 * itself answers the question: a character device (the null device, a terminal) is not a channel
 * the session keeps open, a FIFO or a socket is.
 */
export function stdinIsChannel(fd = 0) {
  try {
    const st = fstatSync(fd);
    return st.isFIFO() || st.isSocket();
  } catch { return false; }
}

/**
 * One SSE frame -> the line to print, or null when it must NOT be printed.
 *
 * Null for our own messages (see the file header) and for anything unreadable: a monitor that
 * prints a guess would put invented words into the session.
 */
/** The seq of one frame, 0 when it carries none (the lifecycle event does not). */
function seqOf(raw) {
  try {
    const msg = JSON.parse(raw);
    return Number(msg?.seq) || 0;
  } catch {
    return 0;
  }
}

export function frameToLine(raw, { members = [], selfSessionId = null, collabId = null, after = 0, wakeOnCode = true } = {}) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return null; }
  if (!msg || typeof msg !== "object") return null;
  // The channel's own lifecycle event (relay: `event: closed`, data { collab_id }).
  if (!msg.seq) return msg.collab_id ? collabClosedLine(msg.collab_id) : null;
  // Already printed: a frame that arrives twice must not become two lines in the session.
  if (Number(msg.seq) <= Number(after)) return null;
  // The session id alone is NOT enough (s. the file header): the relay stamps a HUMAN message from
  // this pane's channel view with THIS session's id. Only the agent's own contributions go back.
  if (selfSessionId && msg.from_session === selfSessionId && msg.author_kind !== "human") return null;
  // A code line (WI 11517979) wakes an idle agent only where its human allowed it (mandate `wake`).
  // Without the wake the state is still taken in -- at the end of the agent's next turn, by the Stop
  // hook -- and every line costs tokens on the workitem whether anybody is watching or not.
  // A QUESTION to the humans (`escalate`) is always shown: it is what needs an answer.
  if (msg.kind === "code" && !wakeOnCode && msg.payload?.type !== "escalate") return null;
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

/**
 * Starts the channel receive path and returns a handle, or `null` where the ring has not released
 * the channel.
 *
 * `null` is the answer the caller needs: it means "there is nothing to stop and nothing that could
 * have been announced" -- on a machine outside the ring this function must not touch the relay at
 * all (no poll, no stream, no line).
 *
 * The caller owns the writer: the process that starts this also writes the relay's own lines, and
 * two writers on one stdout would each keep their own spacing (the spacing exists because Claude
 * Code bundles lines that follow within ~200 ms, s. listen.js). `writeLine.flush()` at session end
 * is the caller's job too -- it belongs to the writer.
 *
 * `ended` resolves when the receive path is fully down (timers cleared, streams closed).
 *
 * `stdin` and `isChannel` are the seam for the one case a test cannot build for itself: the harness
 * hands this process `/dev/null` (s. the stdin block below), and a test cannot make its OWN stdin
 * the null device. A double that emits `end` the moment it is resumed is what `/dev/null` does.
 */
export async function startCollabListener({ writeLine, env = process.env, stdin = process.stdin, isChannel = stdinIsChannel, codeServing = defaultCodeServing } = {}) {
  // The ring decides (s. collabReleased): outside it this receive path does not run at all -- no
  // poll, no stream, no line. Logged once, because "the channel is silent" and "the channel was
  // never switched on here" look identical from inside a session.
  if (!collabReleased(env)) {
    log.info("kwcollab ist auf diesem Rechner nicht freigegeben (KWOS_COLLAB_CANARY) -- kein Empfang.");
    return null;
  }
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
  // WHO KEEPS THIS PROCESS ALIVE -- and who may end it (measured 2026-10-19).
  //
  // The process used to die right after the start (exit 0, not one line: measured 2026-10-19,
  // tgoebel/forkmann). Both timers are unref'd on purpose (review finding Kai, 2026-10-16: a
  // referenced tick kept polling the relay as an orphan), and a PAUSED stdin holds nothing in
  // Node -- so with no stream and no timer there was no handle at all and the loop was empty.
  //
  // The repair bound the process to stdin (`resume()`, then `end`/`close` -> `stop()`), on the
  // assumption that the session holds that pipe open and closes it at the end. That assumption is
  // wrong for the way the harness actually starts a plugin monitor: the spawn line ends in
  // `< /dev/null` (measured in `ps`), so the EOF arrives AT ONCE -- `end` fired before the first
  // poll came back, `stop()` resolved `ended`, and the teardown cleared the poll timer and aborted
  // every stream a moment after it had opened. The channel then looked dead inside the session
  // while every surface still showed it (the message is in the relay's table, and the overview
  // reads that table). The monitor process itself lived on, because the relay path holds it -- so
  // nothing looked broken.
  //
  // Only a real channel may decide that the session is over: `stdinIsChannel()` tells a pipe or a
  // socket from the null device, so `resume()` still anchors the standalone entry where something
  // really holds it, and `/dev/null` never ends the receive path. In the composed monitor the
  // caller owns this process anyway (`server/monitor.js` stops this path after `relay.ended`).
  try {
    stdin.resume?.();
    if (isChannel()) {
      stdin.on("end", stop);
      stdin.on("close", stop);
      stdin.on("error", stop);
    } else {
      // Not our anchor: the caller owns the process, and a read error on a stdin we do not use
      // must not end the receive path either -- an unhandled 'error' would take the monitor down.
      stdin.on("error", () => {});
      log.info("stdin ist kein Kanal (/dev/null) -- der Kollab-Empfang lebt mit dem Prozess, nicht mit stdin.");
    }
  } catch { /* kein stdin (Sonderfaelle/Windows): dann haelt der Aufrufer den Prozess */ }

  // One stream per channel, keyed by collab id. Kept across polls, so a channel we are already in
  // is not re-opened every 15 s (that would replay the backlog again and again).
  const open = new Map();

  const closeAll = () => {
    for (const [id, entry] of open) { entry.controller.abort(); code?.drop(id); }
    open.clear();
  };

  // Code exchange (WI 11517979): serve this worktree's snapshots while it is in code mode, and read
  // the own mandate's `wake`. Only where the worktree has joined -- a local file test first, the
  // relay only after it -- so the hundreds of sessions without code mode pay nothing for it.
  const code = codeServing ? codeServing({ cwd: process.cwd() }) : null;

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
      if (!wanted.has(id)) { entry.controller.abort(); open.delete(id); code?.drop(id); }
    }
    for (const c of joined) {
      const members = Array.isArray(c.members) ? c.members : [];
      const existing = open.get(c.collab_id);
      if (existing) {
        // Same stream, fresh names: the member list is what turns an opaque login into a display
        // name, and it grows while the channel is open (review finding 2026-10-16 -- the list used
        // to be frozen at the moment the stream was opened, so later joiners stayed logins).
        existing.members = members;
        await code?.refresh(c.collab_id, existing);
        continue;
      }
      const controller = new AbortController();
      // `lastSeq` is the SSE cursor (written to disk, advanced by every id). `printedSeq` is what
      // the session has already SEEN, and only a printed line advances it: the id arrives before
      // the message, so deduplicating against the cursor would swallow the frame it belongs to.
      const entry = { controller, members, lastSeq: readCursor(c.collab_id) ?? 0 };
      entry.printedSeq = entry.lastSeq;
      open.set(c.collab_id, entry);
      await code?.refresh(c.collab_id, entry);
      log.info("Collab-Kanal verbunden.", { collabId: c.collab_id, workitem: c.workitem });
      runSseReceiver(
        (raw) => {
          const line = frameToLine(raw, {
            members: entry.members, selfSessionId: config.sessionId, collabId: c.collab_id,
            // Already printed in THIS process: a reconnect must not repeat a line (the receiver
            // resumes by `Last-Event-ID`, this is the second belt for a frame that arrives twice).
            after: entry.printedSeq,
            wakeOnCode: entry.wake !== false,
          });
          if (!line) return;
          entry.printedSeq = Math.max(entry.printedSeq, seqOf(raw));
          writeLine(line);
        },
        {
          signal: controller.signal,
          url: collab.collabEventsUrl(c.collab_id),
          // THIS machine's place in the channel, kept on disk: a closed and reopened session
          // starts a new process, and without the note it asks the relay for the whole protocol
          // again (field report 2026-10-19).
          since: entry.lastSeq > 0 ? entry.lastSeq : null,
          onEventId: (id) => {
            const seq = Number(id);
            if (!Number.isFinite(seq) || seq <= entry.lastSeq) return;
            entry.lastSeq = seq;
            rememberCursor(c.collab_id, seq);
          },
        }
      ).catch((err) => {
        if (!controller.signal.aborted) log.error("Collab-Empfang beendet.", { error: String(err) });
      });
    }
  }

  // `/clear` and `--resume` hand out a new session id inside this process: the streams belong to
  // the OLD one and would stay deaf. Same rule as the session listener (listen.js).
  //
  // The id is tracked LOCALLY, for the same reason as there (2026-10-19, WI 11506447): this path
  // now shares `config.sessionId` with the relay path in ONE process, and a watcher that trusted
  // the shared "changed" answer would miss the change whenever the other one read the marker first
  // -- and with it the re-accept below, which is what keeps the channel after a /clear.
  //
  // UNREF'D, and that is a review finding and not a detail (Kai, 2026-10-16, on the re-bind timer
  // in `index.js`): an open stdin already keeps this process up for as long as the session lives,
  // so a timer that is NOT unref'd does not hold anything together -- it only decides what happens
  // after the session is gone. The orphan then keeps polling the relay every 15 s for a session
  // nobody is in any more. Measured on the sibling timer: 47 ms to exit with it unref'd, still
  // alive 10 s later without.
  let boundId = config.sessionId;
  const watch = setInterval(async () => {
    if (stopping) return;
    try {
      await refreshSessionId();
    } catch (err) {
      log.error("Session-ID konnte nicht neu gelesen werden.", { error: String(err) });
    }
    if (config.sessionId === boundId) return;
    boundId = config.sessionId;
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

  let pollTimer = null;
  // The receive path comes up in the background and tears itself down when `stop()` is called --
  // so the caller holds a handle immediately, and `ended` means "everything is down", not "the
  // first poll is back". `pollTimer` is assigned inside, hence the guard in the teardown: a stop
  // that arrives before the first poll returned must not leave the interval running.
  const running = (async () => {
    await poll();
    pollTimer = setInterval(() => { poll().catch(() => {}); }, COLLAB_POLL_MS);
    // `unref` bleibt (Review-Fund Kai, s. den Test): der Takt soll den Prozess NICHT ueber die
    // Sitzung hinaus am Leben halten. Was ihn haelt, ist das abonnierte stdin oben -- ein Punkt,
    // den die Sitzung selbst beendet.
    pollTimer.unref();
    await ended;
  })()
    .catch((err) => log.error("Collab-Empfang beendet.", { error: String(err) }))
    .finally(() => {
      clearInterval(watch);
      if (pollTimer) clearInterval(pollTimer);
      closeAll();
    });

  return { stop, ended: running };
}

// Standalone entry (the folded-in path is what runs in a session, s. server/monitor.js): useful to
// watch one receive path on its own, and what the file header above describes.
async function main() {
  const writeLine = createLineWriter(process.stdout);
  const listener = await startCollabListener({ writeLine });
  // Outside the ring: nothing was started, nothing to wait for, nothing to flush.
  if (!listener) return;
  await listener.ended;
  await writeLine.flush();
}

// Guard as in index.js/listen.js: an `import` from a test must not open a real SSE connection.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    log.error("Unerwarteter Fehler im Collab-Listener.", { error: String(err) });
    process.exit(1);
  });
}
