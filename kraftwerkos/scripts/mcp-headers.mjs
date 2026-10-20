#!/usr/bin/env node
/**
 * mcp-headers.mjs — the headers for the kw/OS MCP server (`headersHelper`).
 *
 * WHY THIS EXISTS: `kraftwerk-os` used to be declared with `oauth.callbackPort: 54545` in
 * `.mcp.json` — a FIXED port. A machine runs many sessions at once (measured: seven), and every
 * session that wants to authenticate binds exactly that one port. The second one gets, for good:
 *
 *     OAuth callback port 54545 is already in use -- another process may be holding it.
 *
 * Measured on 2026-10-20, two probes against the real endpoints:
 *
 *   1. `https://xid.supinfo.de/oidc/auth?...&redirect_uri=http://localhost:61234/callback` answers
 *      303 and redirects to EXACTLY that URI (the error in the query is only the missing PKCE) — an
 *      authorization server validates the redirect_uri BEFORE redirecting, so the client `mcp_kos`
 *      accepts ANY loopback port. The fixed port was never a requirement of the auth server.
 *   2. `https://os.kraftwerk.io/mcp` takes the XID access token DIRECTLY: `initialize` and
 *      `tools/list` answer 200 (the full tool list), and a `tools/call` runs into the argument
 *      validation. So no OAuth is needed at all — only the token the fleet already has.
 *
 * The token comes from the same helper as everywhere else (`xiam-token.ps1`/`.sh`; the same call
 * `kwos-session-bus/server/auth.js` makes) — ONE source, no second login path.
 *
 * OUTPUT: exactly one JSON object with the headers on stdout, nothing else. On failure `{}` and
 * exit 1 (the same shape as `bootstrap/xiam-mcp-headers.ps1` in the litellm repo), so Claude Code
 * shows the server as not connected instead of asking with invented headers.
 *
 * NO BROWSER, EVER: the helper runs in the background (MCP connect, reconnect) and must not open a
 * login dialog — `XIAM_REFRESH_ONLY=1` enforces that, exactly as in the session bus. Whoever is
 * logged in has a refresh-token cache; whoever is not gets a line on stderr instead of a window in
 * the middle of their work.
 *
 * CROSS-PLATFORM, and why it is done THIS way:
 *
 *   * Claude Code runs a `headersHelper` as a COMMAND LINE (`sh -c <headersHelper>` on POSIX, the
 *     equivalent on Windows) — which is why `.mcp.json` says `node "<path>"` and not a bare script
 *     path: nothing needs an exec bit (which a Windows checkout or a tarball does not carry
 *     reliably anyway), and the path is QUOTED because a user directory may contain a space.
 *   * ONE entry point for all three platforms: `.mcp.json` is static JSON and cannot name a
 *     different command per platform. Node is a given in this environment (the sibling plugin
 *     `kwos-session-bus` IS a Node MCP server, and the fleet's launcher gate requires Node).
 *   * The token helper is called PER PLATFORM: `powershell -File …ps1` on Windows, `bash …sh`
 *     otherwise — the same call as in `kwos-session-bus/server/auth.js`. `bash` and not `sh`:
 *     `xiam-token.sh` carries `#!/usr/bin/env bash`, and on Debian/Ubuntu `sh` is `dash`.
 *   * Both calls pass the path as its OWN argv element (never a shell string), so a space in the
 *     path cannot be split a second time.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/** How long the token helper may take — after that it counts as unreachable. */
const HELPER_TIMEOUT_MS = 20_000;

const isWindows = platform() === "win32";

/** The same path and the same overrides as the session bus: ONE vocabulary. */
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

const headers = { Authorization: `Bearer ${accessToken()}` };
/** The workitem, when the session has one — kw/OS attributes what this belongs to with it. */
const workitem = (process.env.KWOS_WORKITEM || "").trim();
if (workitem !== "") headers["X-KWOS-Workitem"] = workitem;

process.stdout.write(JSON.stringify(headers));
