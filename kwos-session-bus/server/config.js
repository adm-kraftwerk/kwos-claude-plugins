import { randomUUID } from "node:crypto";
import { homedir, platform } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { log } from "./log.js";

// Basis-URL des Session Relay Service (Workitem-9831619). Bewusst kein
// Hardcoding — Vorgabe aus der Server-Spec ("URL aus Gateway-Konfiguration").
const RELAY_URL = process.env.KWOS_RELAY_URL;
if (!RELAY_URL) {
  log.error("KWOS_RELAY_URL ist nicht gesetzt — der Session Bus kann sich nicht registrieren.");
}

// Auth: der Relay validiert das XID-Access-Token selbst via /oidc/me (siehe
// Abweichungs-Kommentar an Workitem-9831619). Frueher wurde eine Cache-Datei
// (~/.kwos/xiam-token.json) angenommen, die niemand je geschrieben hat -- s. auth.js:
// der Helper (xiam-token.sh/.ps1, derselbe wie bei kwclaude) wird jetzt selbst aufgerufen,
// vom bereits etablierten Installationspfad aus CLI-SETUP.md.
const DEFAULT_TOKEN_HELPER_PATH = join(
  homedir(), ".config", "kraftwerk",
  platform() === "win32" ? "xiam-token.ps1" : "xiam-token.sh"
);
const TOKEN_HELPER_PATH = process.env.KWOS_XID_TOKEN_HELPER_PATH || DEFAULT_TOKEN_HELPER_PATH;
const TOKEN_OVERRIDE = process.env.KWOS_XID_ACCESS_TOKEN;

// Claude-Code-Session-ID: weder der stdio-MCP-Server noch ein per `monitors` gestarteter
// Prozess bekommt CLAUDE_CODE_SESSION_ID in der Umgebung (vormals offene Frage, siehe README).
// Aufgelöst über: 1) CLAUDE_CODE_SESSION_ID, falls doch gesetzt (Override) 2) Marker-Datei
// ".kwos-session-bus-id" im Projektverzeichnis, geschrieben von einem SessionStart-Hook
// (hooks/write-session-id.js) 3) lokal generierte UUID mit klar geloggter Warnung.
const SESSION_ID_FILE = ".kwos-session-bus-id";

function findSessionIdFile(startDir) {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, SESSION_ID_FILE);
    if (existsSync(candidate)) {
      try {
        const id = readFileSync(candidate, "utf8").trim();
        if (id) return id;
      } catch { /* ignore, keep walking up */ }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hook und dieser Prozess starten unabhaengig voneinander (SessionStart-Hook vs. `monitors`/
// stdio-MCP) -- kurzes Polling statt eines einmaligen Checks, damit die Reihenfolge egal ist.
async function resolveSessionId() {
  const fromEnv = process.env.CLAUDE_CODE_SESSION_ID;
  if (fromEnv) return fromEnv;

  for (let attempt = 0; attempt < 10; attempt++) {
    const fromFile = findSessionIdFile(process.cwd());
    if (fromFile) return fromFile;
    await sleep(500);
  }

  const generated = randomUUID();
  log.error(
    `Keine echte session_id gefunden (weder CLAUDE_CODE_SESSION_ID noch ${SESSION_ID_FILE}) — ` +
      `verwende lokal generierte Session-ID (${generated}). Relay-Attribution passt dadurch nicht zusammen.`
  );
  return generated;
}

export const config = {
  relayUrl: RELAY_URL ? RELAY_URL.replace(/\/$/, "") : undefined,
  tokenHelperPath: TOKEN_HELPER_PATH,
  tokenOverride: TOKEN_OVERRIDE,
  sessionId: undefined,
  displayName: process.env.KWOS_SESSION_DISPLAY_NAME || undefined,
  heartbeatIntervalMs: 5 * 60 * 1000, // Vorschlag Server-Spec §3.1: alle 5 Min
  ttlMinutes: 30,
};

/** Muss vor jeder Nutzung von config.sessionId aufgerufen werden (einmalig, memoisiert). */
export async function ensureSessionId() {
  if (!config.sessionId) config.sessionId = await resolveSessionId();
  return config.sessionId;
}
