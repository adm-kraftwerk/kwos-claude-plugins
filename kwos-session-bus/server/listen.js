#!/usr/bin/env node
// server/listen.js — Command für den kw/OS-Session-Bus-Monitor (monitors/monitors.json).
//
// Läuft NICHT als MCP-Server, sondern als einfacher Langlebig-Prozess, den Claude Code
// per `monitors`-Manifest-Key selbst startet (offizielles Primitiv, siehe Workitem-9831620-
// Kommentar vom 2026-07-16). stdout-Zeilen werden von Claude Code als Notification an die
// Session geliefert — deshalb: NUR eine formatierte Zeile pro eingehender Nachricht auf
// stdout, alles Diagnostische auf stderr (Konvention wie beim MCP-Server, s. log.js).
//
// ACHTUNG, hier galt bis WI 11075502 die Annahme "jede Zeile ist eine eigene Notification".
// Das ist gemessen falsch: Claude Code kappt jede Zeile bei 500 Zeichen und buendelt dicht
// aufeinanderfolgende Zeilen zu EINER Notification mit 3000-Zeichen-Limit. Eine lange Nachricht
// kommt also NICHT vollstaendig an. formatLine() kappt deshalb selbst (s. MAX_LINE_CHARS) und
// nennt im Marker die seq, mit der die Session den Rest per get_message-Tool nachholt.
//
// Kein Autowake einer inaktiven Session (siehe Workitem-9831620 §2.2) — das Monitor-Tool
// liefert die Notification, was Claude damit macht, entscheidet die jeweilige Session selbst
// (Reaction Policy §2.3: wie User-Input behandeln, nicht blind ausführen).

import { config, ensureSessionId, refreshSessionId } from "./config.js";
import { isMainModule } from "./is-main.js";
import { log } from "./log.js";
import * as relay from "./relay-client.js";
import { runSseReceiver } from "./sse-receiver.js";

// Bild-Upload (WI 10460008, Phase 2): relay/lib.js serialize() liefert jetzt attachment_id mit
// (null, wenn kein Bild). Der Hinweis hier macht die Nachricht sichtbar -- der Abruf selbst
// passiert erst, wenn die Session sich per get_attachment-Tool aktiv dafuer entscheidet (kein
// Autowake, keine Aenderung an der Reaction Policy, s. Kommentar oben im File).
//
// Kappung (WI 11075502): Claude Code kappt jede Monitor-Zeile bei 500 Zeichen -- gemessen kommt
// eine 500er Zeile vollstaendig an, eine 501er verliert ein Zeichen und bekommt "...(truncated)".
// Gezaehlt werden ZEICHEN, nicht Bytes (eigene Messung zu WI 11075502: eine Zeile aus 501 Umlauten
// = 1002 Bytes wird erst bei Zeichen 500 gekappt, nicht bei Byte 500) -- deshalb ist MAX_LINE_CHARS
// eine Zeichen- und keine Byte-Grenze, und deutscher Text verliert nicht die Haelfte des Budgets.
// Zeilen, die dicht beieinander geschrieben werden, werden ausserdem zu EINER Notification
// gebuendelt und dann bei 3000 Zeichen gekappt. Der Harness kappt am ZEILENENDE -- und dort steht
// der Bild-Hinweis, also genau das, was den Abruf erst ermoeglicht. Deshalb kappt sich die Zeile
// hier SELBST, mit Reserve unter der 500er-Grenze, und nennt im Marker die volle Laenge plus die
// seq, mit der die Session den Rest per get_message-Tool nachholt. Belege und Messprotokolle:
// Workitem 11075502.
export const MAX_LINE_CHARS = 480;

// Zeilen, die dichter als das Buendelungsfenster des Harness aufeinander folgen (~200 ms, gemessen
// bei WI 11075502), werden zu EINER Notification zusammengefasst und dann bei 3000 Zeichen
// gekappt. Gemessen: 12 Zeilen a 480 Zeichen ohne Abstand -> eine Notification mit A01..A06
// komplett, A07 halb und A08..A12 SPURLOS weg (kein Marker, also nicht nachholbar); dieselben
// Zeilen mit 250 ms Abstand -> je eigene Notifications. Kontrolllauf mit 8 Zeilen (3840 Zeichen,
// ohne Abstand also gekappt): 8 von 8 vollstaendig. Im 12er-Lauf waren 11 von 12 sichtbar, die
// 12. Zeile war nachweislich geschrieben -- diese eine fehlende Notification ist nicht erklaert,
// deshalb steht hier bewusst kein "12 von 12". Der Abstand ist das, was den stillen Totalverlust
// verhindert -- nicht Kosmetik. Real erreichbar: beim
// SSE-Reconnect liefert der Relay bis zu 500 Backlog-Nachrichten in einer engen Schleife
// (relay/server.js), das ist genau so ein Buendel.
export const LINE_SPACING_MS = 250;

// How long a "(1/n) " part is held before it is written on its own. The relay splits a long
// message BEFORE it stores the parts (relay/lib.js splitLongMessage) and inserts them in one
// loop, so the parts of one message arrive milliseconds apart; a second is generous and still
// short enough not to be noticed as a delay. The spacing of LINE_SPACING_MS cannot help here:
// the parts are written in one tight loop, so the harness bundles exactly them -- which is how
// 5 of 12 lines disappeared in the measurement above.
export const SPLIT_HOLD_MS = 1000;

// Obergrenze fuer den Wiederholungsabstand nach einem Schreibfehler (Backoff verdoppelt von
// LINE_SPACING_MS aus) -- ein dauerhaft kaputtes stdout soll nicht im Sekundenbruchteil
// protokollieren.
const MAX_RETRY_MS = 5000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Schreibt Zeilen einzeln und mit Mindestabstand -- die erste sofort, jede weitere erst
 * LINE_SPACING_MS nach der VORIGEN ZEILE (nicht nur innerhalb eines Drains: sonst schreibt jeder
 * einzelne Aufruf sofort, weil seine Queue beim Aufruf leer ist, und der Abstand greift nie --
 * genau daran ist die erste Fassung gescheitert, der Test hat es gefangen). Eine einzelne
 * Nachricht wird dadurch nie verzoegert; nur ein Schwall (Backlog beim Reconnect) wird
 * auseinandergezogen. Reihenfolge bleibt erhalten, keine Zeile geht verloren.
 */
export function createLineWriter(stream, { spacingMs = LINE_SPACING_MS } = {}) {
  const queue = [];
  let running = null;
  // Eigener Boolean statt "running ist truthy": ein Drain, der ohne await durchlaeuft, setzt in
  // seinem finally schon running=null, BEVOR `running = drain()` in start() zuweist -- danach
  // haelt running ein bereits erledigtes Promise, start() haelt den Drain faelschlich fuer aktiv
  // und schreibt NIE wieder. Genau daran ist die Fassung ohne dieses Flag gescheitert.
  let active = false;
  let lastWriteAt = null;

  async function drain() {
    active = true;
    try {
      while (queue.length) {
        if (lastWriteAt !== null) {
          // Monotone Zeitbasis (performance.now), nicht Date.now: ein Systemzeit-Sprung
          // rueckwaerts wuerde sonst eine riesige Wartezeit ergeben und den Drain blockieren.
          const wait = spacingMs - (performance.now() - lastWriteAt);
          if (wait > 0) await defaultSleep(wait);
        }
        // Erst schreiben, DANN aus der Queue nehmen: wirft write() (z.B. EPIPE), bleibt die Zeile
        // vorne liegen und wird beim naechsten Anlauf nachgeholt -- ein stiller Verlust waere
        // genau das, was dieser Fix verhindern soll.
        stream.write(queue[0] + "\n");
        queue.shift();
        lastWriteAt = performance.now();
      }
    } finally {
      active = false;
      running = null;
    }
  }

  function start() {
    if (!active) running = drain();
    return running;
  }

  // Nach einem Schreibfehler plant sich der Drain selbst neu ein. Ohne das wartet er auf die
  // NAECHSTE eingehende Zeile -- kommt keine mehr, steht die Warteschlange fuer immer, und weil
  // der Relay die Nachricht beim Push schon als zugestellt markiert, ist sie dann die einzige
  // Kopie (Review-Fund zu WI 11075502). Mit Backoff, damit ein dauerhaft kaputtes stdout (EPIPE)
  // nicht alle 250 ms eine Fehlerzeile protokolliert.
  function kick(attempt = 0) {
    start().catch((err) => {
      const delay = Math.min(spacingMs * 2 ** attempt, MAX_RETRY_MS);
      log.error("Zeile konnte nicht geschrieben werden, neuer Versuch.", { error: String(err), delayMs: delay });
      const t = setTimeout(() => kick(attempt + 1), delay);
      t.unref?.();
    });
  }

  const write = (line) => {
    queue.push(line);
    kick();
  };

  // Fuer das Session-Ende: main() bricht den SSE-Empfang ab und kehrt zurueck -- ohne Flush ginge
  // die noch gepufferte Warteschlange verloren (im Backlog-Fall bis zu ~125 s Benachrichtigungen).
  // Wartet auf die QUEUE, nicht auf den laufenden Drain: nach einem Schreibfehler ist der null,
  // waehrend der Wiederholungs-Timer noch laeuft. Mit Deadline, damit ein dauerhaft kaputtes
  // stdout das Session-Ende nicht blockiert.
  write.flush = async ({ timeoutMs = 5000 } = {}) => {
    const deadline = performance.now() + timeoutMs;
    while (queue.length && performance.now() < deadline) await defaultSleep(25);
  };
  return write;
}

/**
 * One notification per logical message. The relay splits a long message into parts "(i/n) "
 * before it stores them (relay/lib.js splitLongMessage), each part with its own seq -- so the
 * monitor received a whole run of lines for ONE message. Lines written back to back are bundled
 * by the harness and capped at 3000 characters, and the measurement at LINE_SPACING_MS lost 5 of
 * 12 lines without a trace: of 6 parts, only part 1 arrived.
 *
 * So the head of a run is held for `windowMs` to learn whether parts follow; if they do, the head
 * is written ONCE with a hint naming the seq that returns the whole message (get_message already
 * reassembles the parts), and the rest of the run is suppressed up to "(n/n)". When the
 * association is not certain -- a sender change, another n, a gap, or no head at all -- the part
 * is written instead: swallowing something that cannot be assigned is the one thing worse than a
 * second notification.
 *
 * `onWrite(rawData)` is called for a held head the moment the coalescer releases it (part 2
 * arrived, the window elapsed, or flush()). Everything the caller should write is returned as
 * `{action:"write", data}`; the caller formats both the same way. Return values: `write`, `hold`,
 * `drop`.
 */
export function createSplitCoalescer({ windowMs = SPLIT_HOLD_MS, onWrite = () => {} } = {}) {
  // The held head of the current run, with the timer that will release it on its own.
  let held = null;
  // Parts of a run whose head was already written: dropped until "(n/n)" ends the run.
  let suppressing = null;

  function releaseHeld({ withHint = false } = {}) {
    const current = held;
    held = null;
    if (!current) return;
    if (current.timer) clearTimeout(current.timer);
    onWrite(withHint ? withSplitHint(current) : current.raw);
  }

  function hold(part) {
    const timer = setTimeout(() => {
      // Only release what THIS timer was set for -- a later head may have replaced it.
      if (held && held.timer === timer) releaseHeld();
    }, windowMs);
    // The window must never be a reason for the process to stay alive; the session's own end
    // comes from the signal, and flush() covers a held line at that point.
    timer.unref?.();
    held = { ...part, timer };
  }

  function feed(rawData) {
    const part = parseSplitPart(rawData);

    if (held) {
      const head = held;
      if (part && part.from === head.from && part.total === head.total && part.index === 2) {
        // Confirmed run: the one line goes out now, naming the head's seq.
        releaseHeld({ withHint: true });
        // "(2/2)" ends the run with this part; otherwise the parts still to come are dropped.
        suppressing = head.total > 2 ? { from: head.from, total: head.total, next: 3 } : null;
        return { action: "drop" };
      }
      // Not certainly the second part of the held head: release it as it is (its own "(1/n) "
      // prefix still says there is more) and decide on this frame on its own.
      releaseHeld();
    }

    if (suppressing) {
      const run = suppressing;
      if (part && part.from === run.from && part.total === run.total && part.index === run.next) {
        run.next += 1;
        if (run.next > run.total) suppressing = null;
        return { action: "drop" };
      }
      // A gap or a different message: this part cannot be assigned to the run we know.
      suppressing = null;
    }

    if (part && part.index === 1 && part.total > 1) {
      hold(part);
      return { action: "hold" };
    }
    // No head, no numbering, or a part that cannot be a head: written, never swallowed.
    return { action: "write", data: rawData };
  }

  function flush() {
    if (!held) return false;
    releaseHeld();
    return true;
  }

  return { feed, flush };
}

/** "(i/n) rest" -> { msg, from, index, total }; null when the frame is not a numbered part. */
function parseSplitPart(rawData) {
  let msg;
  try {
    msg = JSON.parse(rawData);
  } catch {
    return null;
  }
  const text = msg?.text;
  const m = typeof text === "string" ? /^\((\d+)\/(\d+)\) ?/.exec(text) : null;
  if (!m) return null;
  const index = Number(m[1]);
  const total = Number(m[2]);
  // Same bounds as relay-client.js parseChunkMarker: a malformed numbering is not a part.
  if (!Number.isInteger(index) || !Number.isInteger(total) || total < 2 || index < 1 || index > total) return null;
  return { msg, raw: rawData, from: msg.from_session || "unknown", index, total };
}

/** The held head, carrying the hint that the rest is retrievable in one call. */
function withSplitHint({ msg, total }) {
  const hint = Number.isInteger(msg?.seq)
    ? `[Nachricht in ${total} Teilen -- get_message(seq=${msg.seq})]`
    : `[Nachricht in ${total} Teilen -- mit get_message nachholbar]`;
  return JSON.stringify({ ...msg, split_hint: hint });
}

/**
 * Verdrahtung SSE-Frame -> Coalescer -> formatierte Zeile -> Writer. Eigene, exportierte Funktion,
 * damit genau diese Naht getestet werden kann: ohne sie laesst sich die Verdrahtung in main()
 * zurueckdrehen (direkt `process.stdout.write(formatLine(...))`), ohne dass ein Test rot wird --
 * und der stille Totalverlust waere zurueck (Review-Fund F4 zu WI 11075502).
 *
 * The coalescer is created HERE by default, so that every caller of this seam gets the one
 * notification per message -- a wiring that could be forgotten in main() would be exactly the
 * silent regression this function exists to prevent. `forward.flush()` releases a held head; the
 * listener calls it before the writer's own flush drains the queue.
 */
export function forwardToWriter(writeLine, { windowMs = SPLIT_HOLD_MS, coalescer = null } = {}) {
  const split = coalescer ?? createSplitCoalescer({ windowMs, onWrite: (raw) => writeLine(formatLine(raw)) });
  const forward = (rawData) => {
    const decision = split.feed(rawData);
    if (decision.action === "write") writeLine(formatLine(decision.data));
  };
  // A held head is released here at session end -- nothing else would ever write it.
  forward.flush = () => split.flush();
  return forward;
}

export function formatLine(rawData) {
  try {
    const msg = JSON.parse(rawData);
    const from = msg.from_session || "unknown";
    const hasAttachment = Boolean(msg.attachment_id);
    // msg.text kann bei einer reinen Bildnachricht fehlen (relay/server.js akzeptiert "text ODER
    // attachment_id"). Der fruehere "?? rawData"-Fallback haette in genau diesem Fall die GANZE
    // rohe JSON-Zeile als Text angezeigt, statt den Bild-Hinweis -- Regressionstest in
    // tests/listen.test.js deckt das ab.
    const raw = msg.text ?? (hasAttachment ? "(Bild ohne Text)" : rawData);
    const text = typeof raw === "string" ? raw : String(raw);
    const hint = hasAttachment
      ? ` [Bild angehängt, attachment_id=${msg.attachment_id} -- mit get_attachment abrufbar]`
      : "";
    // The split hint of a coalesced message (s. createSplitCoalescer) travels on the frame itself
    // -- it is rendered here so that it is part of the character budget and cannot be cut off.
    const extra = typeof msg.split_hint === "string" && msg.split_hint ? ` ${msg.split_hint}` : "";
    const prefix = `[${from}]: `;

    if (prefix.length + text.length + hint.length + extra.length <= MAX_LINE_CHARS) {
      return `${prefix}${text}${hint}${extra}`;
    }

    if (extra) {
      // The split hint names the seq that returns the WHOLE message (get_message reassembles the
      // parts), so it replaces the truncation marker instead of competing with it for the same
      // 480 characters: "the hint has priority" is the rule of this fix.
      const keep = Math.max(0, MAX_LINE_CHARS - prefix.length - hint.length - extra.length - 1);
      return `${prefix}${text.slice(0, keep)}…${hint}${extra}`.slice(0, MAX_LINE_CHARS);
    }

    // Nur eine echte, ganzzahlige seq (relay/lib.js serialize(): seq = Number(row.seq)) ist
    // brauchbar -- ein geratener/fehlender Wert darf keinen get_message-Hinweis erzeugen, der
    // ins Leere greift.
    const seq = Number.isInteger(msg.seq) ? msg.seq : null;
    const marker = ` … [+${text.length} Zeichen${seq === null ? "" : ` -- get_message(seq=${seq})`}]`;
    const keep = Math.max(0, MAX_LINE_CHARS - prefix.length - marker.length - hint.length);
    return `${prefix}${text.slice(0, keep)}${marker}${hint}`.slice(0, MAX_LINE_CHARS);
  } catch {
    // Gleiche Invariante wie oben: auch unparsebare Rohdaten duerfen die Zeile nicht sprengen.
    return typeof rawData === "string" ? rawData.slice(0, MAX_LINE_CHARS) : rawData;
  }
}

// The relay receive path as a startable function: the ONE monitor process (server/monitor.js) runs
// this, and -- where the ring released the channel -- the kwcollab receive path next to it. It
// stood here as a `main()` of its own until 2026-10-19; the reason for the split is the fleet leak
// in collab-listen.js's header (WI 11506447): a monitor cannot be started mid-session, so the one
// process that exists in every session has to be the one that carries both paths.
//
// `writeLine` is the caller's: both paths write to the same stdout, and two writers would each keep
// their own spacing (s. createLineWriter) -- which is what the spacing is there to prevent.
export async function startRelayListener({ writeLine } = {}) {
  // Eigenständig registrieren statt sich auf die Startreihenfolge des MCP-Servers zu
  // verlassen (register ist idempotent) — vermeidet eine Race zwischen den beiden
  // unabhängig gestarteten Prozessen (MCP-Server per stdio, dieser Monitor per `monitors`).
  await ensureSessionId();
  await registerOrLog();

  let controller = new AbortController();
  let stopping = false;
  let signalEnded;
  const ended = new Promise((resolve) => { signalEnded = resolve; });
  const stop = () => { stopping = true; controller.abort(); signalEnded(); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const out = writeLine ?? createLineWriter(process.stdout);
  // One seam for both readers of the stream: the coalescer turns a split message into one line
  // (s. createSplitCoalescer) before the writer's spacing is applied.
  const forward = forwardToWriter(out);

  // `/clear` and `--resume` give this Claude Code process a NEW session id while this monitor keeps
  // running. The SessionStart hook rewrites our marker; nothing else would ever tell us, and a
  // stream left open under the old id is deaf to every message the PWA sends to the session it
  // shows (it queues in relay.messages instead). So: re-read the marker, and on a change drop the
  // stream, re-register and reconnect under the new id.
  //
  // Deliberately NOT unref'd: it is also what keeps this process alive across the gap between
  // aborting one stream and opening the next. An unref'd timer would let the process exit in
  // exactly that moment, and a monitor that quietly disappears is worse than one that never ran.
  //
  // The id is tracked LOCALLY (2026-10-19, WI 11506447): `config.sessionId` is now shared with the
  // channel's receive path, which runs in this same process and watches the same marker. A watcher
  // that trusted `refreshSessionId()`'s "changed" answer would go deaf whenever the OTHER one read
  // the marker first -- it would be told "nothing changed" while its own stream still sits on the
  // old id. So: let the shared answer move, and compare against what THIS path last bound.
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
    controller.abort();
    controller = new AbortController();
    await registerOrLog();
    receive(controller);
  }, config.sessionIdCheckMs);

  function receive(ctrl) {
    runSseReceiver(forward, { signal: ctrl.signal }).catch((err) => {
      // Only reachable for a failure the receiver itself does not swallow; its own reconnect loop
      // handles a dead stream. Worth a line, not a crash.
      if (!ctrl.signal.aborted) log.error("SSE-Empfang beendet.", { error: String(err) });
    });
  }

  receive(controller);

  // A monitor ends when its session ends, not when one stream ends -- a dropped stream is the
  // receiver's own business (it reconnects on its own). So the caller waits for the signal, not for
  // the stream; at that point the interval is gone. `flush()` stays with the writer's owner.
  //
  // The held head of a split message goes out HERE, before `ended` resolves: the caller's
  // `writeLine.flush()` then drains it with the rest, instead of it dying with the process.
  const running = ended.finally(() => {
    clearInterval(watch);
    forward.flush();
  });
  return { stop, ended: running };
}

// Standalone entry (node server/listen.js): the relay path on its own, useful for debugging.
async function main() {
  const writeLine = createLineWriter(process.stdout);
  const listener = await startRelayListener({ writeLine });
  try {
    await listener.ended;
  } finally {
    // Beim Session-Ende noch gepufferte Zeilen ausliefern, statt sie mit dem Prozess zu verlieren.
    await writeLine.flush();
  }
}

async function registerOrLog() {
  try {
    await relay.register();
  } catch (err) {
    log.error("Registrierung (Listener) fehlgeschlagen.", { error: String(err) });
  }
}

// Guard wie in index.js -- ein `import` aus einem Test soll nicht sofort eine echte
// SSE-Verbindung/Registrierung auslösen. Der Vergleich läuft über isMainModule und damit auf
// aufgelösten Pfaden: ein verlinktes Plugin-Verzeichnis ließ die rohe String-Fassung hier still
// falsch antworten, und der Monitor endete mit Exit 0 und leerem stdout UND stderr (WI 11550391,
// roter Test auf dem Windows-Specimen am 2026-11-18).
if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    log.error("Unerwarteter Fehler im Session-Bus-Listener.", { error: String(err) });
    process.exit(1);
  });
}
