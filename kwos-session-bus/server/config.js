import { randomUUID } from "node:crypto";
import { homedir, platform } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { log } from "./log.js";
import { MARKER_DIR, LEGACY_MARKER_FILE, clientMarkerName } from "./sessionMarker.js";

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

// Claude-Code-Session-ID -- CORRECTED 2026-10-14 (measured on a live session):
//
// 1. `CLAUDE_CODE_SESSION_ID` IS in the environment of a process started the way the MCP server or
//    a `monitors` process is started. The previous note here ("weder … noch …") was wrong -- the
//    value sat in the environment of a shell-spawned node process, next to the launcher's KWOS_*
//    exports. But it is FROZEN at process start, and that is the whole problem: after `/clear` and
//    `--resume` Claude Code hands out a NEW session id inside the same process, while every child
//    keeps the old one. The relay hooks (which see the real id per event) then register the session
//    under the new id, while the listener subscribes under the old one -- and a message sent to the
//    session the PWA shows reaches nobody. It stays in relay.messages as "queued" and nothing
//    anywhere reports an error (Befund Steffen 2026-10-14).
//
// 2. The marker file is rewritten on every SessionStart, so it carries the CURRENT truth. It is
//    keyed by the launcher's KWOS_CLIENT_ID, not by directory: one plain file per project directory
//    is last-writer-wins, and two sessions in the same directory would share it. `refreshSessionId`
//    below is what turns the file into the re-bind after `/clear`.
//
// Order: own marker (short poll -- the hook and this process start independently) -> frozen env ->
// legacy per-directory marker (older hooks) -> generated UUID with a loud warning.
export function findMarker(startDir, relativeFile) {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, relativeFile);
    if (existsSync(candidate)) {
      try {
        const id = readFileSync(candidate, "utf8").trim();
        if (id) return { path: candidate, id };
      } catch { /* ignore, keep walking up */ }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const OWN_MARKER_NAME = clientMarkerName(process.env.KWOS_CLIENT_ID);
const ownMarker = () => (OWN_MARKER_NAME ? findMarker(process.cwd(), join(MARKER_DIR, OWN_MARKER_NAME)) : null);

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

// Nutzer-eigener Name (`claude --name`/`-n` beim Start, oder `/rename` waehrend der Sitzung) ist
// informativer als der cwd-Basename -- besonders wenn dasselbe Repo mehrfach parallel laeuft und
// alle Karten in der PWA sonst identisch "litellm" heissen. Claude Code fuehrt dafuer lokal pro
// laufendem Prozess ~/.claude/sessions/<pid>.json, z. B. {"pid":64745,"cwd":"...",
// "name":"litellm-00","nameSource":"derived"} -- kein Hook traegt den Namen im Payload (gegen die
// offizielle Hooks-Doku geprueft), das ist der einzig verlaessliche Weg ohne die Statusline zu
// kapern. `nameSource` unterscheidet Claude Codes Auto-Slug ("derived") von einem echten
// Nutzer-Namen -- nur Letzterer ist informativer als der Basename, ein Auto-Slug waere kein
// Gewinn gegenueber deriveDisplayName().
// process.ppid ist fuer den stdio-MCP-Server die PID des startenden claude-Prozesses (direktes
// Kind) -- fuer `monitors` (Bash-Snapshot-Mechanik, s. RELAY_URL oben) ist der Elternprozess
// vermutlich eine Shell, nicht claude selbst, die Datei existiert dann unter dieser PID schlicht
// nicht. Kein Fehlerfall: faellt sauber auf deriveDisplayName() zurueck, wie bei RELAY_URL/
// KWOS_CHANNELS oben.
function readClaudeSessionName() {
  try {
    const raw = readFileSync(join(homedir(), ".claude", "sessions", `${process.ppid}.json`), "utf8");
    const { name, nameSource } = JSON.parse(raw);
    if (typeof name === "string" && name.trim() && nameSource !== "derived") return name.trim();
  } catch { /* Datei fehlt/kaputt/falsche PID (Monitor-Pfad) -- Fallback deriveDisplayName() */ }
  return null;
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
  // Own marker first: it is the only source that stays true across /clear and --resume. Short poll
  // only (4 x 500ms) -- the frozen env value below is right at process start anyway, so a hook that
  // is slow to write must not delay a working session; `refreshSessionId` picks it up later.
  for (let attempt = 0; attempt < 4; attempt++) {
    const own = ownMarker();
    if (own) return own.id;
    await sleep(500);
  }

  const fromEnv = process.env.CLAUDE_CODE_SESSION_ID;
  if (fromEnv) return fromEnv;

  for (let attempt = 0; attempt < 10; attempt++) {
    const legacy = findMarker(process.cwd(), LEGACY_MARKER_FILE);
    if (legacy) return legacy.id;
    await sleep(500);
  }

  const generated = randomUUID();
  log.error(
    `Keine echte session_id gefunden (weder ${join(MARKER_DIR, OWN_MARKER_NAME || "<client-id>")}, ` +
      `CLAUDE_CODE_SESSION_ID noch ${LEGACY_MARKER_FILE}) — verwende lokal generierte Session-ID ` +
      `(${generated}). Relay-Attribution passt dadurch nicht zusammen.`
  );
  return generated;
}

export const config = {
  relayUrl: RELAY_URL ? RELAY_URL.replace(/\/$/, "") : undefined,
  tokenHelperPath: TOKEN_HELPER_PATH,
  tokenOverride: TOKEN_OVERRIDE,
  sessionId: undefined,
  displayName: process.env.KWOS_SESSION_DISPLAY_NAME || readClaudeSessionName() || deriveDisplayName(process.cwd()),
  channels: deriveChannels(process.cwd()),
  heartbeatIntervalMs: 5 * 60 * 1000, // Vorschlag Server-Spec §3.1: alle 5 Min
  // How often a long-running process re-reads its own marker. The file is a few bytes and the check
  // is one stat+read; 5s costs nothing and bounds how long a /clear can go unnoticed. Same interval
  // as CLAUDE_CODE_SESSION_ID_CHECK_MS in the launchers' world: the latency the reader feels.
  sessionIdCheckMs: readCheckInterval(process.env.KWOS_SESSION_ID_CHECK_MS),
  ttlMinutes: 30,
  /**
   * The collab channel this session was STARTED INTO (WI 11482928), or null.
   *
   * Set by whoever starts the session -- today the interfaces that open a session from an
   * invitation, which put `KWOS_COLLAB` into the child's environment. The session then joins that
   * channel itself, because it is the only party that knows its own Claude Code session id (the
   * relay's accept requires a session the caller owns). A launcher cannot do it: it does not know
   * the id Claude Code will pick -- the same chicken-and-egg the approval token solves with its own
   * marker.
   */
  collab: typeof process.env.KWOS_COLLAB === "string" && process.env.KWOS_COLLAB.trim()
    ? process.env.KWOS_COLLAB.trim()
    : null,
};

/**
 * The poll interval from the environment, or the default. A typo must not become the interval:
 * `setInterval(fn, NaN)` and `setInterval(fn, 0)` both fire every millisecond, and this check runs
 * as a stat+read in two processes per session. Anything below the floor is a busy loop, not a
 * polling interval, so it falls back to the default as well.
 */
export function readCheckInterval(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 250 ? n : 5000;
}

/** Muss vor jeder Nutzung von config.sessionId aufgerufen werden (einmalig, memoisiert). */
export async function ensureSessionId() {
  if (!config.sessionId) config.sessionId = await resolveSessionId();
  return config.sessionId;
}

/** The exact file this process tracks, or null when the launcher sent no client id. */
export function sessionIdMarkerPath() {
  return ownMarker()?.path ?? null;
}

/**
 * Re-reads the own marker and adopts a new session id. Returns true when it CHANGED -- the caller
 * then has to re-register and reopen its SSE stream under the new id.
 *
 * This is the fix for `/clear` and `--resume`: Claude Code hands out a new session id inside the
 * same process, the SessionStart hook rewrites the marker, and nothing else would ever tell the
 * already-running MCP server or monitor. Without this the session stays subscribed under an id
 * that no longer exists: the PWA lists the session (the relay hooks see the real id per event),
 * the listener listens on the old one, and every message sent from the phone is queued forever.
 *
 * A marker that is missing is NOT a change: a project directory without the hook (or with an older
 * one that never wrote it) must keep the id it resolved at startup, not lose it.
 */
export async function refreshSessionId() {
  const own = ownMarker();
  if (!own || own.id === config.sessionId) return false;
  const previous = config.sessionId;
  config.sessionId = own.id;
  log.info("Session-ID gewechselt (/clear oder --resume) — binde neu.", { previous, sessionId: own.id });
  return true;
}
