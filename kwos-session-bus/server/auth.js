import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { config } from "./config.js";
import { log } from "./log.js";

const HELPER_TIMEOUT_MS = 20_000;

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

let cachedToken;

/**
 * Liefert das XID-Access-Token für den Authorization-Header.
 * Reihenfolge: KWOS_XID_ACCESS_TOKEN-Override > Helper-Skript (xiam-token.sh/.ps1, derselbe
 * Login-Flow wie bei kwclaude, refresh-only). Bei transientem Fehlschlag Rueckfall auf das
 * zuletzt bekannte Token, damit ein einzelner Netzwerk-Ausfall nicht sofort alles blockiert.
 */
export async function getAccessToken() {
  if (config.tokenOverride) return config.tokenOverride;

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
    throw new Error(`Kein XID-Access-Token verfügbar: ${err}`);
  }
}
