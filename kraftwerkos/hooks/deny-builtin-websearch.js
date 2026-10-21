#!/usr/bin/env node
/**
 * PreToolUse hook: keep Claude Code's built-in WebSearch out of gateway sessions.
 *
 * Native WebSearch does not work through the kw/OS gateway -- and it does not fail either: it
 * answers "Did 0 searches" in a second or two and the turn carries on without results. The session
 * looks like it searched, and nothing was searched. The gateway serves its own search instead
 * (`mcp__kw-websearch__web_search`), registered by the launchers through `--mcp-config`.
 *
 * The launchers carry `disabledBuiltinTools: ["WebSearch"]` for exactly this, and Claude Code
 * ignores it: the key belongs to the Desktop/workspace schema, the CLI reads neither it nor a
 * warning. Measured 2026-10-21 on 2.1.306 -- the setting was in the session's own settings file and
 * the tool was still loaded and callable. A PreToolUse hook is the mechanism that works no matter
 * how the tool schema reached the model, and it can SAY what to use instead: the reason travels
 * back to the model, which calls the MCP tool on its own (measured: the model switched without
 * being told, and the answer was correct).
 *
 * Gateway sessions only. A plain `claude` against the Anthropic API has a working WebSearch, and
 * nothing here should take it away.
 */

const GATEWAY_HOST = 'llm.os.kraftwerk.io';

/**
 * Is this session talking to the kw/OS gateway?
 *
 * The address is the reliable signal: the launcher exports ANTHROPIC_BASE_URL for every session it
 * starts, and a session that points somewhere else (Anthropic directly, or a proxy of one's own)
 * must not be touched. The kw/OS variables stand in for a launcher that sets the address some other
 * way; they are never present in a plain `claude` session.
 */
function isGatewaySession(env) {
  if ((env.ANTHROPIC_BASE_URL ?? '').includes(GATEWAY_HOST)) return true;
  return Boolean(env.KWOS_WORKITEM || env.KWOS_CLIENT_ID);
}

const REASON =
  'WebSearch ist im kw/OS-Gateway abgeschaltet: darueber liefert es keine Ergebnisse ' +
  '(es meldet Erfolg und sucht nichts). Nutze stattdessen das MCP-Werkzeug ' +
  'mcp__kw-websearch__web_search, fuer einzelne Seiten mcp__kw-websearch__web_read.';

let payload = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  payload += chunk;
});
process.stdin.on('end', () => {
  // A hook that says nothing leaves the call alone -- that is the answer for every non-gateway
  // session, and the answer when anything below goes wrong.
  if (!isGatewaySession(process.env)) process.exit(0);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: REASON,
      },
    }),
  );
  process.exit(0);
});
