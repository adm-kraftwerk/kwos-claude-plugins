import { randomUUID } from "node:crypto";
import { homedir, platform } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { log } from "./log.js";

// Basis-URL des Session Relay Service (Workitem-9831619). War als reines Env-Override gedacht
// ("URL aus Gateway-Konfiguration") -- fiel aber in der Praxis auf einen `monitors`-Prozess NIE
// durch: Claude Code injiziert settings.json-`env` dokumentiert nur in Bash/PowerShell-Tools,
// tmux, Hooks, die Statusline und stdio-MCP-Server -- `monitors` steht NICHT auf dieser Liste
// (per Prozessbaum bestaetigt: der Monitor laeuft ueber dieselbe Shell-Snapshot/Bash-Mechanik wie
// das Bash-Tool, nicht als direkter Kindprozess von Claude Code). Ergebnis: der Monitor sah
// KWOS_RELAY_URL nie, jede Registrierung/Heartbeat scheiterte fortlaufend still (Fehler nur auf
// stderr, das fuer `monitors` nirgends sichtbar landet). Es gibt in diesem Deployment ohnehin nur
// einen Relay -- Default fest verdrahtet (kein Geheimnis, steht bereits ueberall in Doku/Wiki),
// Override bleibt fuer Tests/andere Deployments moeglich.
const DEFAULT_RELAY_URL = "https://llm.os.kraftwerk.io";
const RELAY_URL = process.env.KWOS_RELAY_URL || DEFAULT_RELAY_URL;

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

// Gleiches Problem wie bei RELAY_URL: KWOS_SESSION_DISPLAY_NAME erreicht den `monitors`-Prozess
// nie (kein Env-Overlay dort, s. oben), und der Relay lehnt eine Registrierung ganz ohne
// display_name mit 400 ab -- REGISTRIERUNG WAERE ALSO SELBST MIT KORREKTEM RELAY_URL NIE
// DURCHGEKOMMEN. cwd() ist dagegen die echte Prozess-Arbeitsverzeichnis-Angabe (kein Env), steht
// also auch dem Monitor zuverlaessig zur Verfuegung. Gleiche Namenskonvention wie die
// serverseitige deriveDisplayName() in relay/lib.js (Basename des Arbeitsverzeichnisses).
function deriveDisplayName(cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) return "Claude Code Session";
  const norm = cwd.replace(/[\\/]+$/, "");
  const base = norm.split(/[\\/]/).pop();
  return base && base.trim() ? base : "Claude Code Session";
}

// Pub/Sub-Channels (WI 10383787): jede Session hoert per Default auf einen Channel gleich dem
// Basename ihres Arbeitsverzeichnisses (dieselbe Ableitung wie displayName, s. o.) -- wer den
// Repo-/Service-Namen kennt, kann die Session damit erreichen, ohne ihre Session-ID zu kennen.
// KWOS_CHANNELS (optional, kommagetrennt) fuer zusaetzliche Channels, die diese Session AUCH
// hoeren soll (z.B. eine konsumierende Session, die den Channel des Services abonniert, von dem
// sie abhaengt). Der Relay mergt Channels aus mehreren Registrierungen per ARRAY-UNION (s.
// relay/server.js) -- kommt KWOS_CHANNELS beim `monitors`-Prozess nicht an (kein Env-Overlay dort,
// s. RELAY_URL oben), geht dadurch nichts verloren, nur der stdio-MCP-Server traegt es bei.
function deriveChannels(cwd) {
  const extra = (process.env.KWOS_CHANNELS || "").split(",").map((c) => c.trim()).filter(Boolean);
  return [...new Set([deriveDisplayName(cwd), ...extra])];
}

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
  displayName: process.env.KWOS_SESSION_DISPLAY_NAME || deriveDisplayName(process.cwd()),
  channels: deriveChannels(process.cwd()),
  heartbeatIntervalMs: 5 * 60 * 1000, // Vorschlag Server-Spec §3.1: alle 5 Min
  ttlMinutes: 30,
};

/** Muss vor jeder Nutzung von config.sessionId aufgerufen werden (einmalig, memoisiert). */
export async function ensureSessionId() {
  if (!config.sessionId) config.sessionId = await resolveSessionId();
  return config.sessionId;
}
