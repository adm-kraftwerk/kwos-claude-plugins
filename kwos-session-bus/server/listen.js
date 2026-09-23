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

import { fileURLToPath } from "node:url";
import { ensureSessionId } from "./config.js";
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
 * Verdrahtung SSE-Frame -> formatierte Zeile -> Writer. Eigene, exportierte Funktion, damit genau
 * diese Naht getestet werden kann: ohne sie laesst sich die Verdrahtung in main() zurueckdrehen
 * (direkt `process.stdout.write(formatLine(...))`), ohne dass ein Test rot wird -- und der stille
 * Totalverlust waere zurueck (Review-Fund F4 zu WI 11075502).
 */
export function forwardToWriter(writeLine) {
  return (rawData) => writeLine(formatLine(rawData));
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
    const prefix = `[${from}]: `;

    if (prefix.length + text.length + hint.length <= MAX_LINE_CHARS) {
      return `${prefix}${text}${hint}`;
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

async function main() {
  // Eigenständig registrieren statt sich auf die Startreihenfolge des MCP-Servers zu
  // verlassen (register ist idempotent) — vermeidet eine Race zwischen den beiden
  // unabhängig gestarteten Prozessen (MCP-Server per stdio, dieser Monitor per `monitors`).
  await ensureSessionId();
  try {
    await relay.register();
  } catch (err) {
    log.error("Registrierung (Listener) fehlgeschlagen.", { error: String(err) });
  }

  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());

  const writeLine = createLineWriter(process.stdout);
  try {
    await runSseReceiver(forwardToWriter(writeLine), { signal: controller.signal });
  } finally {
    // Beim Session-Ende noch gepufferte Zeilen ausliefern, statt sie mit dem Prozess zu verlieren.
    await writeLine.flush();
  }
}

// Guard wie in index.js -- ein `import` aus einem Test soll nicht sofort eine echte
// SSE-Verbindung/Registrierung auslösen.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    log.error("Unerwarteter Fehler im Session-Bus-Listener.", { error: String(err) });
    process.exit(1);
  });
}
