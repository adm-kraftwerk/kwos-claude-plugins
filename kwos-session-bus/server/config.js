import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./log.js";

// Basis-URL des Session Relay Service (Workitem-9831619). Bewusst kein
// Hardcoding — Vorgabe aus der Server-Spec ("URL aus Gateway-Konfiguration").
const RELAY_URL = process.env.KWOS_RELAY_URL;
if (!RELAY_URL) {
  log.error("KWOS_RELAY_URL ist nicht gesetzt — der Session Bus kann sich nicht registrieren.");
}

// Auth: der Relay validiert das XID-Access-Token selbst via /oidc/me (siehe
// Abweichungs-Kommentar an Workitem-9831619) — kein separates OBO-Handling nötig.
// Pfad zum Token-Cache ist nicht spezifiziert ("xiam-token-helper-cache"); wir nehmen
// das bereits etablierte ~/.kwos-Verzeichnis an (siehe kraftwerkos-Plugin) und legen
// den Dateinamen so lange fest, bis das gegengeprüft ist.
const DEFAULT_TOKEN_CACHE_PATH = join(homedir(), ".kwos", "xiam-token.json");
const TOKEN_CACHE_PATH = process.env.KWOS_XID_TOKEN_CACHE_PATH || DEFAULT_TOKEN_CACHE_PATH;
const TOKEN_OVERRIDE = process.env.KWOS_XID_ACCESS_TOKEN;

// Claude-Code-Session-ID: kein bekannter Mechanismus, wie ein per stdio gestarteter
// MCP-Server an die x-claude-code-session-id herankommt (offene Frage, siehe README).
// Fallback: lokal generierte UUID mit klar geloggter Warnung.
function resolveSessionId() {
  const fromEnv = process.env.CLAUDE_CODE_SESSION_ID;
  if (fromEnv) return fromEnv;
  const generated = randomUUID();
  log.error(
    `CLAUDE_CODE_SESSION_ID nicht gesetzt — verwende lokal generierte Session-ID (${generated}). ` +
      "Relay-/Gateway-/OTLP-Attribution passt dadurch NICHT zusammen (siehe Workitem-9831620, offene Frage)."
  );
  return generated;
}

export const config = {
  relayUrl: RELAY_URL ? RELAY_URL.replace(/\/$/, "") : undefined,
  tokenCachePath: TOKEN_CACHE_PATH,
  tokenOverride: TOKEN_OVERRIDE,
  sessionId: resolveSessionId(),
  displayName: process.env.KWOS_SESSION_DISPLAY_NAME || undefined,
  heartbeatIntervalMs: 5 * 60 * 1000, // Vorschlag Server-Spec §3.1: alle 5 Min
  ttlMinutes: 30,
};
