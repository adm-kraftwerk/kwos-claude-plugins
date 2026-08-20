#!/usr/bin/env node
// server/listen.js — Command für den kw/OS-Session-Bus-Monitor (monitors/monitors.json).
//
// Läuft NICHT als MCP-Server, sondern als einfacher Langlebig-Prozess, den Claude Code
// per `monitors`-Manifest-Key selbst startet (offizielles Primitiv, siehe Workitem-9831620-
// Kommentar vom 2026-07-16). Jede stdout-Zeile wird von Claude Code als Notification an die
// Session geliefert — deshalb: NUR eine formatierte Zeile pro eingehender Nachricht auf
// stdout, alles Diagnostische auf stderr (Konvention wie beim MCP-Server, s. log.js).
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
export function formatLine(rawData) {
  try {
    const msg = JSON.parse(rawData);
    const from = msg.from_session || "unknown";
    const hasAttachment = Boolean(msg.attachment_id);
    // msg.text kann bei einer reinen Bildnachricht fehlen (relay/server.js akzeptiert "text ODER
    // attachment_id"). Der fruehere "?? rawData"-Fallback haette in genau diesem Fall die GANZE
    // rohe JSON-Zeile als Text angezeigt, statt den Bild-Hinweis -- Regressionstest in
    // tests/listen.test.js deckt das ab.
    const text = msg.text ?? (hasAttachment ? "(Bild ohne Text)" : rawData);
    const hint = hasAttachment
      ? ` [Bild angehängt, attachment_id=${msg.attachment_id} -- mit get_attachment abrufbar]`
      : "";
    return `[${from}]: ${text}${hint}`;
  } catch {
    return rawData;
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

  await runSseReceiver((rawData) => {
    process.stdout.write(formatLine(rawData) + "\n");
  }, { signal: controller.signal });
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
