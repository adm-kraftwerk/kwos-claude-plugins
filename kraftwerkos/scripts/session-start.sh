#!/bin/sh
# session-start.sh — Claude Code SessionStart command hook
#
# Two tasks:
#   1. Local setup — CLAUDE.md injection + sh hook scripts to ~/.kwos/
#   2. Server call — POST session-start body; output response (session ID + workitem carry)

BODY=$(cat)  # drain stdin before any early exit; forwarded to server

MARKER='<!-- kraftwerkOS -->'
CLAUDE_MD="$HOME/.claude/CLAUDE.md"
KWOS_DIR="$HOME/.kwos"
SCRIPT_DIR="$(dirname "$0")"

# SENTINEL = Fingerabdruck der AKTUELLEN Instruktion. Aendert sich der Text unten, MUSS dieser
# Wert mit erhoeht werden -- sonst erreicht die Aenderung bestehende Nutzer NIE: der Block wird
# nur neu geschrieben, wenn er fehlt oder der Fingerabdruck nicht passt. (Vorher wurde
# ausschliesslich die Marker-ANZAHL geprueft -> eine Textaenderung war ein stiller No-Op fuer
# jeden, der den Block schon hatte.)
SENTINEL='kw/OS Workitem Tracking (v3)'

# Die Instruktion ist BEDINGT, aber NUR an KWOS_WORKITEM: in kwclaude-Sessions steht das Workitem
# beim Start fest (Launcher setzt es, Gateway erzwingt es mit 403) -- eine Rueckfrage ist sinnlos.
# BEWUSST NICHT als Abbruchbedingung: ein per Carry uebernommenes Workitem. Das trifft in plain
# claude regelmaessig zu (der Server liefert den Carry frueherer Sessions mit) -> die Frage waere
# dort weggefallen und die Arbeit still auf ein Workitem von gestern gebucht. DASSELBE PLUGIN
# laeuft in beiden Welten (eine Marketplace-Quelle), also trifft jede Textaenderung auch plain
# claude. Der Block liegt in einer DAUERHAFTEN Datei, die beide Welten lesen; deshalb wird die
# Bedingung im TEXT formuliert und nicht beim Schreiben ausgewertet (sonst wuerde der in einer
# kwclaude-Session geschriebene Stand in plain-claude-Sessions weitergelten und umgekehrt).
INSTRUCTION="${MARKER}
## ${SENTINEL}
Skip the question ONLY when the environment variable KWOS_WORKITEM is set (session started via
\`kwclaude\`: the launcher binds the workitem for this session and the gateway enforces it
server-side, so an answer could not change the booking).
Otherwise (plain \`claude\`, no gateway) ask once \"Which kw/OS workitem are you working on?\", then
use ToolSearch with query \"setSessionWorkitem\" to load the MCP tool schema and call it with their
workitemId and the session ID from your context. Never use Bash or shell scripts to set the
workitem — it is always a deferred MCP tool. Only ask once per session.
A workitem CARRIED OVER from an earlier session is NOT a reason to skip the question: offer it as
the default, but still ask — otherwise today's work books onto yesterday's workitem.
${MARKER}"

# ── 1. Local setup ────────────────────────────────────────────────────────────

MARKER_COUNT=$(grep -cF "$MARKER" "$CLAUDE_MD" 2>/dev/null || printf '0')
HAS_SENTINEL=$(grep -cF "$SENTINEL" "$CLAUDE_MD" 2>/dev/null || printf '0')
if ! ([ "$MARKER_COUNT" -eq 2 ] && \
      [ "$HAS_SENTINEL" -ge 1 ] && \
      [ -f "$KWOS_DIR/langfuse-hook.sh"     ] && \
      [ -f "$KWOS_DIR/inject-session-id.sh" ]); then

    mkdir -p "$(dirname "$CLAUDE_MD")" 2>/dev/null
    if [ -f "$CLAUDE_MD" ]; then
        ORIGINAL=$(cat "$CLAUDE_MD")
        # awk uses exact string comparison ($0 == m), not regex — safe for all marker content.
        CLEANED=$(printf '%s\n' "$ORIGINAL" | awk -v m="$MARKER" '
            $0 == m { in_block = !in_block; next }
            !in_block { print }
        ')
        printf '%s\n\n%s\n' "$CLEANED" "$INSTRUCTION" > "$CLAUDE_MD" 2>/dev/null
    else
        printf '%s\n' "$INSTRUCTION" > "$CLAUDE_MD" 2>/dev/null
    fi

    mkdir -p "$KWOS_DIR"
    cp -f "$SCRIPT_DIR/langfuse-hook.sh"     "$KWOS_DIR/" 2>/dev/null
    cp -f "$SCRIPT_DIR/inject-session-id.sh" "$KWOS_DIR/" 2>/dev/null
fi

# ── 2. Server call (session registration + carry lookup) ─────────────────────

PLUGIN_URL="${KWOS_PLUGIN_URL%/}"
if [ -n "$PLUGIN_URL" ]; then
    RESPONSE=$(printf '%s' "$BODY" | curl -sf -X POST "${PLUGIN_URL}/hooks/session-start" \
        -H 'Content-Type: application/json' \
        -H "X-Hook-Secret: ${KWOS_HOOKS_SECRET}" \
        --data @- 2>/dev/null)
    [ -n "$RESPONSE" ] && printf '%s' "$RESPONSE"
fi
exit 0
