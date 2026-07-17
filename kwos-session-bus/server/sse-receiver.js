import { Readable } from "node:stream";
import { getAccessToken } from "./auth.js";
import { eventsUrl } from "./relay-client.js";
import { log } from "./log.js";

const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30000;

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
export async function runSseReceiver(onMessage, { signal }) {
  let lastEventId;
  let delay = RECONNECT_MIN_MS;

  while (!signal.aborted) {
    try {
      const token = await getAccessToken();
      const res = await fetch(eventsUrl(), {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "text/event-stream",
          ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
        },
        signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`SSE-Verbindung fehlgeschlagen: ${res.status}`);
      }

      log.info("SSE verbunden.", { lastEventId });
      delay = RECONNECT_MIN_MS;
      let buffer = "";
      for await (const chunk of Readable.fromWeb(res.body)) {
        buffer += chunk.toString("utf8");
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const { id, data } = parseEvent(rawEvent);
          if (id) lastEventId = id;
          if (data) onMessage(data);
        }
      }
    } catch (err) {
      if (signal.aborted) return;
      log.error("SSE-Verbindung verloren, reconnect.", { error: String(err), delayMs: delay });
    }

    await sleep(delay, signal);
    delay = Math.min(delay * 2, RECONNECT_MAX_MS);
  }
}

function parseEvent(rawEvent) {
  let id;
  const dataLines = [];
  for (const line of rawEvent.split("\n")) {
    if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  return { id, data: dataLines.length ? dataLines.join("\n") : undefined };
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
