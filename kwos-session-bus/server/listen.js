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

import { config } from "./config.js";
import { log } from "./log.js";
import * as relay from "./relay-client.js";
import { runSseReceiver } from "./sse-receiver.js";

function formatLine(rawData) {
  try {
    const msg = JSON.parse(rawData);
    const from = msg.from_session || "unknown";
    const text = msg.text ?? rawData;
    return `[${from}]: ${text}`;
  } catch {
    return rawData;
  }
}

async function main() {
  if (!config.relayUrl) {
    log.error("Kein KWOS_RELAY_URL — Listener kann nicht starten.");
    process.exit(1);
  }

  // Eigenständig registrieren statt sich auf die Startreihenfolge des MCP-Servers zu
  // verlassen (register ist idempotent) — vermeidet eine Race zwischen den beiden
  // unabhängig gestarteten Prozessen (MCP-Server per stdio, dieser Monitor per `monitors`).
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

main().catch((err) => {
  log.error("Unerwarteter Fehler im Session-Bus-Listener.", { error: String(err) });
  process.exit(1);
});
