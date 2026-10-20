#!/usr/bin/env node
/**
 * mcp-headers.mjs — die Kopfzeilen fuer den kw/OS-MCP-Server (`headersHelper`).
 *
 * WARUM ES DAS GIBT: `kraftwerk-os` stand mit `oauth.callbackPort: 54545` in `.mcp.json` — ein
 * FESTER Port. Auf einer Maschine laufen aber viele Sitzungen gleichzeitig (gemessen: sieben), und
 * jede, die sich authentifizieren will, bindet genau diesen einen Port. Die zweite bekommt:
 *
 *     OAuth callback port 54545 is already in use -- another process may be holding it.
 *
 * Gemessen am 2026-10-20, zwei Sonden gegen die echten Endpunkte:
 *
 *   1. `https://xid.supinfo.de/oidc/auth?...&redirect_uri=http://localhost:61234/callback`
 *      antwortet 303 und leitet auf GENAU diese URI weiter (der Fehler im Query ist nur die fehlende
 *      PKCE) — der Client `mcp_kos` akzeptiert also JEDEN Loopback-Port. Der feste Port war nie eine
 *      Anforderung des Autorisierungsservers.
 *   2. `https://os.kraftwerk.io/mcp` nimmt den XID-Access-Token DIREKT: `initialize` und
 *      `tools/list` antworten 200 (volle Werkzeugliste), ein `tools/call` laeuft bis in die
 *      Argumentpruefung durch. Es braucht also gar kein OAuth — nur den Token, den die Flotte
 *      ohnehin hat.
 *
 * Der Token kommt aus demselben Helfer wie ueberall sonst (`xiam-token.ps1`/`.sh`; derselbe Aufruf
 * wie in `kwos-session-bus/server/auth.js`) — EINE Quelle, kein zweiter Anmeldeweg.
 *
 * AUSGABE: genau ein JSON-Objekt mit den Kopfzeilen auf stdout, sonst nichts. Bei einem Fehlschlag
 * `{}` und Exit 1 (dieselbe Form wie `bootstrap/xiam-mcp-headers.ps1` im litellm-Repo), damit Claude
 * Code den Server als nicht verbunden zeigt, statt mit erfundenen Kopfzeilen anzufragen.
 *
 * KEIN BROWSER, NIE: der Helfer laeuft im Hintergrund (MCP-Verbindung, Reconnect) und darf keinen
 * Anmeldedialog aufreissen — `XIAM_REFRESH_ONLY=1` erzwingt das, genau wie beim Session-Bus. Wer
 * angemeldet ist, hat einen Refresh-Token-Cache; wer es nicht ist, bekommt eine Zeile auf stderr
 * statt eines Fensters mitten in der Arbeit.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/** Wie lange der Token-Helfer hoechstens braucht — danach gilt er als nicht erreichbar. */
const HELPER_TIMEOUT_MS = 20_000;

const isWindows = platform() === "win32";

/** Derselbe Pfad und dieselben Uebersteuerungen wie im Session-Bus: EIN Vokabular. */
const helperPath =
  process.env.KWOS_XID_TOKEN_HELPER_PATH ||
  join(homedir(), ".config", "kraftwerk", isWindows ? "xiam-token.ps1" : "xiam-token.sh");

function fail(reason) {
  process.stderr.write(`kraftwerkos/mcp-headers: ${reason}\n`);
  process.stdout.write("{}");
  process.exit(1);
}

function accessToken() {
  const override = (process.env.KWOS_XID_ACCESS_TOKEN || "").trim();
  if (override !== "") return override;
  if (!existsSync(helperPath)) fail(`Token-Helfer nicht gefunden: ${helperPath}`);

  const [command, args] = isWindows
    ? ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helperPath]]
    : ["bash", [helperPath]];
  const result = spawnSync(command, args, {
    env: { ...process.env, XIAM_REFRESH_ONLY: "1" },
    encoding: "utf8",
    timeout: HELPER_TIMEOUT_MS,
  });
  if (result.error) fail(`${command} liess sich nicht starten: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${helperPath} endete mit ${result.status}: ${(result.stderr || "").trim()}`);
  }
  const token = (result.stdout || "").trim();
  if (token === "") fail(`${helperPath} lieferte keinen Token`);
  return token;
}

const headers = { Authorization: `Bearer ${accessToken()}` };
/** Die Workitem-Nummer, wenn die Sitzung eine hat — kw/OS ordnet damit zu, woran das gehoert. */
const workitem = (process.env.KWOS_WORKITEM || "").trim();
if (workitem !== "") headers["X-KWOS-Workitem"] = workitem;

process.stdout.write(JSON.stringify(headers));
