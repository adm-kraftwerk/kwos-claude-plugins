import { getAccessToken } from "./auth.js";
import { eventsUrl } from "./relay-client.js";
import { createStateReporter } from "./log.js";

const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30000;

/**
 * Wie lange ein Strom schweigen darf, bevor er als TOT gilt und neu geöffnet wird.
 *
 * Das Relay schickt alle 25 s `: ping` (`STREAM_PING_MS` in `relay/lib.js`) -- auch in einem Kanal,
 * in dem niemand schreibt. Ein Strom, der 75 s lang kein Byte liefert, ist also nicht ruhig, sondern
 * kaputt: typischerweise eine halboffene Verbindung nach einem Gateway-Neustart, die der Kernel nie
 * beendet hat. Ohne diese Prüfung wartet `for await` dort für immer, der Kanal ist stumm und niemand
 * merkt es -- genau der Fall, den ein Neustart nicht überlebt hat.
 *
 * Drei Ping-Abstände, weil ein einzelner ausgefallener Ping kein Befund ist (GC, Lastspitze, ein
 * wandernder Proxy) -- zwei wären zu knapp, vier zu träge für einen Kanal, an dem Menschen schreiben.
 */
export const STALL_MS = readPositive(process.env.KWOS_SSE_STALL_MS, 3 * 25 * 1000);

/**
 * Hält die SSE-Verbindung zum Relay offen und ruft onMessage(text) für jedes
 * eingehende Message-Event auf. Reconnect mit Last-Event-ID nach Standard-SSE-Pattern
 * (Server-Spec §3.3) — läuft für die Lebensdauer des MCP-Server-Prozesses (= Claude-
 * Code-Session).
 *
 * MVP-Grenze (siehe Workitem-9831620 §2.2/§5): Empfang macht die Nachricht hier nur
 * sichtbar (MCP-Logging-Notification an den Client), es gibt kein Autowake einer
 * inaktiven Session — das ist bewusst außerhalb des MVP-Scopes.
 */
// `url` defaults to the session stream (kwremote). The kwcollab monitor passes the channel's own
// URL (GET /v1/collabs/:id/events) -- the frames, the Last-Event-ID handling and the reconnect are
// the same, and a second receiver next door would be a second place that can get them wrong.
//
// `since` seeds `Last-Event-ID` for the FIRST request, and `onEventId` reports every id that came
// in. The channel monitor uses both to keep its place across PROCESSES: an in-memory id only
// survives a reconnect, so a closed and reopened session asked for the whole protocol again.
export async function runSseReceiver(onMessage, { signal, url = null, since = null, onEventId = null, getToken = getAccessToken, stallMs = STALL_MS, retryMs = RECONNECT_MIN_MS, retryMaxMs = RECONNECT_MAX_MS }) {
  let lastEventId = since === null || since === undefined ? undefined : String(since);
  let delay = retryMs;
  const endpoint = url || eventsUrl();
  // Ein Ausfall, eine Zeile: der Empfänger läuft für die ganze Lebensdauer der Sitzung, und jede
  // gescheiterte Runde zu protokollieren macht aus einem Gateway-Neustart eine Zahlenwand.
  const state = createStateReporter();

  while (!signal.aborted) {
    // Der Strom wird für DIESEN Versuch abgebrochen, wenn er schweigt -- aber die Sitzung soll
    // deswegen nicht enden, darum ein eigener Controller neben dem des Aufrufers.
    const attempt = new AbortController();
    const stopAttempt = () => attempt.abort();
    signal.addEventListener("abort", stopAttempt);
    let stalled = false;
    try {
      const token = await getToken();
      const res = await fetch(endpoint, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "text/event-stream",
          ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
        },
        signal: AbortSignal.any([signal, attempt.signal]),
      });
      if (!res.ok || !res.body) {
        throw new Error(`SSE-Verbindung fehlgeschlagen: ${res.status}`);
      }

      // Die Erholung wird nur gemeldet, wenn vorher etwas ausfiel -- ein Kanal, der den ganzen Tag
      // offen ist, hat keine Zeile nötig.
      state.recovered(endpoint, "SSE verbunden.", { lastEventId });
      delay = retryMs;
      // Der Leser wird AUSDRÜCKLICH geführt, nicht über `for await`: ein schweigender Strom muss
      // sich abbrechen lassen, und ein Abort des Signals beendet nicht jede Quelle -- eine
      // Connection, die hinter einem Proxy hängt, liefert einfach weiter nichts. `reader.cancel()`
      // ist der Griff, der auch eine solche Quelle loslässt.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const stall = armStall(stallMs, () => {
        stalled = true;
        attempt.abort();
        void reader.cancel(new Error("SSE-Strom schweigt")).catch(() => {});
      });
      try {
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          stall.touch();
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const rawEvent = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const { id, data, event } = parseEvent(rawEvent);
            if (id) {
              lastEventId = id;
              if (onEventId) onEventId(id);
            }
            // The event name goes along for the readers that need it (the code exchange's back
            // channel, WI 11517979); the existing readers take one argument and ignore it.
            if (data) onMessage(data, event);
          }
        }
      } finally {
        stall.clear();
      }
      // `reader.cancel()` beendet die Schleife SAUBER (`done`), nicht mit einem Fehler -- ohne
      // diese Zeile ginge ein schweigender Strom als "war zu Ende" durch und würde nicht gemeldet.
      if (stalled) throw new Error(`SSE-Strom schweigt seit ${stallMs} ms`);
    } catch (err) {
      if (signal.aborted) return;
      state.failed(endpoint, stalled ? "SSE-Strom schweigt, Neuaufbau." : "SSE-Verbindung verloren, reconnect.", {
        error: stalled ? `kein Byte in ${stallMs} ms` : String(err),
        delayMs: delay,
      });
    } finally {
      signal.removeEventListener("abort", stopAttempt);
    }

    await sleep(delay, signal);
    delay = Math.min(delay * 2, retryMaxMs);
  }
}

/**
 * Der Wachhund eines laufenden Stroms: `touch()` bei jedem Byte, und nach `ms` ohne Byte feuert er.
 *
 * `unref()`: ein Wachhund darf einen Prozess nicht am Leben halten, der sonst fertig wäre -- der
 * Monitor endet mit seiner Sitzung, nicht mit seinem Timer.
 */
function armStall(ms, onStall) {
  let timer = setTimeout(onStall, ms);
  timer.unref?.();
  return {
    touch() {
      timer.refresh();
    },
    clear() {
      clearTimeout(timer);
    },
  };
}

function readPositive(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function parseEvent(rawEvent) {
  let id;
  let event;
  const dataLines = [];
  for (const line of rawEvent.split("\n")) {
    if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  return { id, event, data: dataLines.length ? dataLines.join("\n") : undefined };
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}
