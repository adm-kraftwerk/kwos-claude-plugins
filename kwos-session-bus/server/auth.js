import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { platform } from "node:os";
import { config } from "./config.js";
import { log } from "./log.js";

const HELPER_TIMEOUT_MS = 20_000;
const XID_ISSUER = process.env.XIAM_ISSUER || "https://xid.supinfo.de";
// The same safety margin the helper uses (`MARGIN_SEC`): a token that dies within the next minute
// counts as gone, so a request never starts on one that expires while it runs.
const CACHE_MARGIN_MS = 60_000;

/**
 * The access token the HELPER already fetched, straight from its shared cache (2026-11-02).
 *
 * WHY THIS EXISTS: `getAccessToken` is called PER REQUEST (relay-client's fetch, codeServe), and
 * every call used to spawn `xiam-token.sh` -- bash plus a python interpreter whose only work was
 * to read a file and print one line. In a session that is dozens of subprocesses a minute, on the
 * path the relay hooks wait for. The helper writes `xiam-access` (`expiry` in epoch seconds, then
 * the token) for exactly this reuse, so this reads it and leaves the spawn to the cache miss.
 *
 * A stale or unreadable file is not an error -- it is a cache miss, and the helper answers.
 *
 * EVERY path is tried (2026-11-03): on Windows the bash and the PowerShell helpers write the same
 * file name into two directories, and a client may have reached this identity through either of
 * them. The first entry that yields a usable token wins; nothing is written.
 */
function cachedAccessToken() {
  for (const path of config.accessCachePaths) {
    const token = readCacheEntry(path);
    if (token) return token;
  }
  return null;
}

function readCacheEntry(path) {
  try {
    const raw = readFileSync(path, "utf8").replace(/^﻿/, "");
    const nl = raw.indexOf("\n");
    if (nl < 0) return null;
    const expires = Number(raw.slice(0, nl));
    const token = raw.slice(nl + 1).trim();
    if (!token || !Number.isFinite(expires)) return null;
    return Date.now() < expires * 1000 - CACHE_MARGIN_MS ? token : null;
  } catch {
    return null;
  }
}

// XIAM_REFRESH_ONLY=1 macht den Helper strikt non-interaktiv: kein Browser, kein Warten auf
// Eingabe, sofortiger Fehlschlag ohne gueltigen Refresh-Token-Cache. Ohne diesen Schalter wuerde
// ein Hintergrundprozess (dieser MCP-Server, der monitors-Listener) bei einer noch nie
// eingeloggten Maschine ein Browserfenster oeffnen bzw. bis zu 5 Minuten blockieren.
function runHelper() {
  return new Promise((resolve, reject) => {
    const isWin = platform() === "win32";
    const cmd = isWin ? "powershell" : "bash";
    const args = isWin
      ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", config.tokenHelperPath]
      : [config.tokenHelperPath];
    const env = { ...process.env, XIAM_REFRESH_ONLY: "1" };
    delete env.KWOS_LOGIN_INTERACTIVE;

    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill();
      reject(new Error(`xiam-token Helper Timeout nach ${HELPER_TIMEOUT_MS}ms`));
    }, HELPER_TIMEOUT_MS);

    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`xiam-token Helper exit ${code}: ${err.trim()}`));
      const token = out.trim();
      if (!token) return reject(new Error(`xiam-token Helper lieferte kein Token: ${err.trim()}`));
      resolve(token);
    });
  });
}

// Diagnose fuer den Fall "Helper klappt manuell im Terminal, aber nicht aus diesem Prozess
// heraus" (Befund Steffen, 2026-08-17): reines Node-`fetch`, OHNE bash/python dazwischen --
// scheitert das HIER schon, ist es ein Netzwerk-/Sandbox-Problem des ganzen monitors-Prozesses;
// klappt es, liegt der Fehler spezifisch im gespawnten bash/python (PATH/SSL-Zertifikate).
async function probeNodeNetwork() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`${XID_ISSUER}/.well-known/openid-configuration`, { signal: ctrl.signal });
    clearTimeout(t);
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// Welchen Interpreter/PATH der Helper GENAU in diesem env aufloesen wuerde -- ohne das wissen
// wir bei einem Fehlschlag nur "post_token() ist irgendwie gescheitert", nicht OB der Helper
// ueberhaupt denselben python3 wie eine interaktive Shell traf (z.B. Apple-System-Python mit
// veralteten CA-Zertifikaten statt Homebrew-Python). Eigener argv-Aufruf statt eines
// zusammengesetzten Bash-`-c`-Strings mit Interpolation, damit hier keine Quoting-Fehlerklasse
// entsteht (s. CLAUDE.md-Lehre im litellm-Repo: keine handgebauten String-Kommandos).
function probeShellEnv(env) {
  return new Promise((resolve) => {
    const isWin = platform() === "win32";
    const cmd = isWin ? "powershell" : "bash";
    const args = isWin
      ? ["-NoProfile", "-Command",
         "'HOME=' + $env:USERPROFILE; 'PATH=' + $env:PATH; " +
         "(Get-Command python3,python -ErrorAction SilentlyContinue | Select-Object -First 1).Source"]
      : ["-c", 'echo "HOME=$HOME"; echo "PATH=$PATH"; command -v python3 || command -v python || command -v py || echo "kein Interpreter gefunden"'];
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => finish(out.trim()));
    child.on("error", (e) => finish(`probe fehlgeschlagen: ${e.message}`));
    setTimeout(() => finish(out.trim() || "probe timeout nach 5000ms"), 5000).unref();
  });
}

let cachedToken;

/**
 * Liefert das XID-Access-Token für den Authorization-Header.
 * Reihenfolge: KWOS_XID_ACCESS_TOKEN-Override > Helper-Skript (xiam-token.sh/.ps1, derselbe
 * Login-Flow wie bei kwclaude, refresh-only). Bei transientem Fehlschlag Rueckfall auf das
 * zuletzt bekannte Token, damit ein einzelner Netzwerk-Ausfall nicht sofort alles blockiert.
 */
export async function getAccessToken() {
  if (config.tokenOverride) return config.tokenOverride;

  // THE FILE BEFORE THE PROCESS (2026-11-02): a token the helper already fetched is one read
  // away, and this function runs on every relay request. The helper is the miss path, not the
  // default one.
  const shared = cachedAccessToken();
  if (shared) {
    cachedToken = shared;
    return shared;
  }

  if (!existsSync(config.tokenHelperPath)) {
    if (cachedToken) return cachedToken;
    throw new Error(
      `xiam-token Helper nicht gefunden (${config.tokenHelperPath}) — kein kwclaude-Setup ` +
        "auf dieser Maschine, kein Login moeglich. KWOS_XID_TOKEN_HELPER_PATH oder " +
        "KWOS_XID_ACCESS_TOKEN setzen."
    );
  }

  try {
    const token = await runHelper();
    cachedToken = token;
    return token;
  } catch (err) {
    if (cachedToken) {
      log.error("Token-Refresh fehlgeschlagen, verwende zuletzt bekanntes Token.", {
        error: String(err),
      });
      return cachedToken;
    }
    // Kein Fallback-Token vorhanden (typischerweise beim allerersten Verbindungsaufbau) -- BEVOR
    // wir aufgeben, Diagnose sammeln. Befund Steffen (2026-08-17): derselbe Helper-Aufruf klappt
    // manuell im Terminal, aus diesem Prozess heraus aber nicht -- ohne diese Felder bleibt jeder
    // Fehlschlag nur "Refresh fehlgeschlagen (...)" ohne Hinweis, WARUM der Kindprozess eine
    // andere Welt sieht als eine interaktive Shell.
    const env = { ...process.env, XIAM_REFRESH_ONLY: "1" };
    delete env.KWOS_LOGIN_INTERACTIVE;
    const [nodeFetchToXid, shellEnvSeenByHelper] = await Promise.all([
      probeNodeNetwork(),
      probeShellEnv(env),
    ]);
    log.error("xiam-token Helper fehlgeschlagen -- Diagnose.", {
      error: String(err),
      nodeFetchToXid,
      shellEnvSeenByHelper,
    });
    throw new Error(`Kein XID-Access-Token verfügbar: ${err}`);
  }
}
