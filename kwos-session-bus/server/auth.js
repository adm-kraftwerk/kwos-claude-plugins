import { readFile } from "node:fs/promises";
import { config } from "./config.js";
import { log } from "./log.js";

let cachedToken;

/**
 * Liefert das XID-Access-Token für den Authorization-Header.
 * Reihenfolge: KWOS_XID_ACCESS_TOKEN-Override > Token-Cache-Datei.
 * Wird pro Aufruf frisch aus der Cache-Datei gelesen (kein eigenes Refresh/Expiry-
 * Handling hier — das übernimmt der Prozess, der die Cache-Datei schreibt).
 */
export async function getAccessToken() {
  if (config.tokenOverride) return config.tokenOverride;

  try {
    const raw = await readFile(config.tokenCachePath, "utf8");
    const parsed = JSON.parse(raw);
    const token = parsed.access_token || parsed.accessToken;
    if (!token) {
      throw new Error(`Keine access_token/accessToken-Property in ${config.tokenCachePath}`);
    }
    cachedToken = token;
    return token;
  } catch (err) {
    if (cachedToken) {
      log.error("Token-Cache nicht lesbar, verwende zuletzt bekanntes Token.", {
        path: config.tokenCachePath,
        error: String(err),
      });
      return cachedToken;
    }
    throw new Error(
      `Kein XID-Access-Token verfügbar (Cache-Pfad: ${config.tokenCachePath}). ` +
        "Pfad/Format ist eine Annahme (siehe README) — ggf. KWOS_XID_TOKEN_CACHE_PATH " +
        `oder KWOS_XID_ACCESS_TOKEN setzen. Ursache: ${err}`
    );
  }
}
