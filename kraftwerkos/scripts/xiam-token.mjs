/**
 * xiam-token.mjs — das Personen-Token fuer alle Helfer dieses Plugins, an EINER Stelle.
 *
 * WARUM ES DIESE DATEI GIBT: `mcp-headers.mjs` holte den Token selbst, und ein zweiter Helfer mit
 * eigener Kopie waere die zweite Wahrheit ueber denselben Login. Der Token kommt aus demselben
 * Werkzeug wie ueberall in der Flotte (`xiam-token.ps1`/`.sh`; dieselbe Datei, die
 * `kwos-session-bus/server/auth.js` und `bootstrap/kwclaude-gw.sh` rufen) — EIN Login, keine
 * zweite Quelle.
 *
 * KEIN BROWSER, NIE: die Helfer laufen im Hintergrund (MCP-Verbindung, Wiederverbindung) und
 * duerfen keinen Anmeldedialog oeffnen — `XIAM_REFRESH_ONLY=1` erzwingt das. Wer angemeldet ist,
 * hat einen Refresh-Token-Cache; wer nicht, bekommt eine Zeile auf stderr statt eines Fensters
 * mitten in der Arbeit.
 *
 * PLATTFORM: dieselbe Aufrufform wie in `kwos-session-bus/server/auth.js` — `powershell -File …ps1`
 * auf Windows, `bash …sh` sonst (`bash` und nicht `sh`: die Datei traegt `#!/usr/bin/env bash`, und
 * auf Debian/Ubuntu ist `sh` ein `dash`). Der Pfad geht als EIGENES argv-Element, nie als
 * Shell-Zeichenkette, damit ein Leerzeichen im Pfad nicht ein zweites Mal getrennt wird.
 *
 * Der Token wird NIE protokolliert und nie in eine Datei geschrieben.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/** Wie lange das Token-Werkzeug brauchen darf — danach gilt es als nicht erreichbar. */
const HELPER_TIMEOUT_MS = 20_000;

const isWindows = platform() === "win32";

/** Derselbe Pfad und dieselben Overrides wie die Session-Bus-Helfer: EIN Vokabular. */
export const helperPath =
  process.env.KWOS_XID_TOKEN_HELPER_PATH ||
  join(homedir(), ".config", "kraftwerk", isWindows ? "xiam-token.ps1" : "xiam-token.sh");

/**
 * Das Access-Token der angemeldeten Person.
 *
 * @param {(reason: string) => never} fail — wird bei jedem Fehlschlag gerufen (die Aufrufer
 *   antworten unterschiedlich: der Header-Helfer schreibt `{}` und endet, das MCP nennt den Grund).
 */
export function accessToken(fail) {
  const override = (process.env.KWOS_XID_ACCESS_TOKEN || "").trim();
  if (override !== "") return override;
  if (!existsSync(helperPath)) fail(`token helper not found: ${helperPath}`);

  const [command, args] = isWindows
    ? ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helperPath]]
    : ["bash", [helperPath]];
  const result = spawnSync(command, args, {
    env: { ...process.env, XIAM_REFRESH_ONLY: "1" },
    encoding: "utf8",
    timeout: HELPER_TIMEOUT_MS,
  });
  if (result.error) fail(`${command} could not be started: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${helperPath} exited with ${result.status}: ${(result.stderr || "").trim()}`);
  }
  const token = (result.stdout || "").trim();
  if (token === "") fail(`${helperPath} returned no token`);
  return token;
}
