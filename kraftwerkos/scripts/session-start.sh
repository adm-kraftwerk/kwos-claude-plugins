#!/bin/sh
# session-start.sh — Claude Code SessionStart command hook
#
# Two tasks:
#   1. Local setup — CLAUDE.md injection + sh hook scripts to ~/.kwos/
#   2. Server call — POST session-start body; output response (session ID + workitem carry)
#
# WARUM die Anweisung in ~/.claude/CLAUDE.md INJIZIERT wird und nicht als Plugin-Datei mitkommt:
# ein CLAUDE.md im Plugin-Root wird laut Claude-Code-Doku NICHT als Kontext geladen ("Plugins
# contribute context through skills, agents, and hooks rather than CLAUDE.md"). Die Injektion ist
# also der einzige Weg, eine dauerhaft wirksame Anweisung auszuliefern -- sie darf NICHT durch eine
# Plugin-eigene CLAUDE.md ersetzt werden (2026-08-05 geprueft, Annahme vorher falsch).

BODY=$(cat)  # drain stdin before any early exit; forwarded to server

MARKER='<!-- kraftwerkOS -->'
CLAUDE_MD="$HOME/.claude/CLAUDE.md"
KWOS_DIR="$HOME/.kwos"
SCRIPT_DIR="$(dirname "$0")"

# Phrase, die JEDE Fassung der Anweisung enthaelt -- Zaehler dafuer, ob genau EINE Kopie existiert.
QUESTION='Which kw/OS workitem are you working on'

# SENTINEL = Fingerabdruck der AKTUELLEN Instruktion. Aendert sich der Text unten, MUSS dieser
# Wert mit erhoeht werden -- sonst erreicht die Aenderung bestehende Nutzer NIE.
SENTINEL='kw/OS Workitem Tracking (v5)'

# Die Instruktion ist BEDINGT an einer im KONTEXT SICHTBAREN Zeile ("WORKITEM BOUND:"), die dieser
# Hook unten ausgibt, wenn KWOS_WORKITEM gesetzt ist. Frueher lautete die Bedingung "wenn die
# Umgebungsvariable KWOS_WORKITEM gesetzt ist" -- die kann der Agent aber NICHT pruefen (keine
# Env-Sicht, und Shell-Aufrufe sind fuer das Workitem ausdruecklich verboten). Folge war eine
# Rueckfrage, OB die Session ueber kwclaude laeuft: schlimmer als vorher.
# BEWUSST NICHT als Abbruchbedingung: ein per Carry uebernommenes Workitem. Das trifft in plain
# claude regelmaessig zu (der Server liefert den Carry frueherer Sessions mit) -> die Frage waere
# dort weggefallen und die Arbeit still auf ein Workitem von gestern gebucht. DASSELBE PLUGIN
# laeuft in beiden Welten (eine Marketplace-Quelle), also trifft jede Textaenderung auch plain
# claude. Der Block liegt in einer DAUERHAFTEN Datei, die beide Welten lesen; deshalb wird die
# Bedingung im TEXT formuliert und nicht beim Schreiben ausgewertet.
INSTRUCTION="${MARKER}
## ${SENTINEL}
If the [kraftwerkOS] block in your context contains a line starting with \"WORKITEM BOUND:\", the
workitem for this session is already fixed (started via \`kwclaude\`; the gateway enforces it
server-side and books the cost). Then, in order:
  1. Do NOT ask the user anything about the workitem.
  2. If an \"OTEL token-tracking session ID\" is ALSO present in your context, silently call
     setSessionWorkitem with the bound ID and that session ID.
  3. If that session ID is NOT present, do nothing further and say nothing about it. Cost
     attribution already happens server-side; the tracking link is optional.
NEVER search for a session ID: no Bash, no grep, no find, no reading of session or log files, no
directory listings. If it is not in your context, it does not exist for you.
Otherwise (plain \`claude\`, no gateway) ask once \"${QUESTION}?\", then
use ToolSearch with query \"setSessionWorkitem\" to load the MCP tool schema and call it with their
workitemId and the session ID from your context. Never use Bash or shell scripts to set the
workitem — it is always a deferred MCP tool. Only ask once per session.
A workitem CARRIED OVER from an earlier session is NOT a reason to skip the question: offer it as
the default, but still ask — otherwise today's work books onto yesterday's workitem.
${MARKER}"

# ── 1. Local setup ────────────────────────────────────────────────────────────

MARKER_COUNT=$(grep -cF "$MARKER" "$CLAUDE_MD" 2>/dev/null || printf '0')
HAS_SENTINEL=$(grep -cF "$SENTINEL" "$CLAUDE_MD" 2>/dev/null || printf '0')
# Genau EINE Kopie der Anweisung ist der Sollzustand. Mehr heisst: es liegen ALT-KOPIEN ausserhalb
# der Marker herum (aus der Zeit vor den Markern). Die widersprechen dem aktuellen Block -- die
# alte Fassung ist kategorisch formuliert und gewinnt, dadurch fragte kwclaude weiter nach dem
# Workitem, obwohl der neue Block das ausschliesst (gemeldet 2026-08-05 von einem WSL-Client).
QUESTION_COUNT=$(grep -cF "$QUESTION" "$CLAUDE_MD" 2>/dev/null || printf '0')

if ! ([ "$MARKER_COUNT" -eq 2 ] && \
      [ "$HAS_SENTINEL" -ge 1 ] && \
      [ "$QUESTION_COUNT" -eq 1 ] && \
      [ -f "$KWOS_DIR/langfuse-hook.sh"     ] && \
      [ -f "$KWOS_DIR/inject-session-id.sh" ]); then

    mkdir -p "$(dirname "$CLAUDE_MD")" 2>/dev/null
    if [ -f "$CLAUDE_MD" ]; then
        ORIGINAL=$(cat "$CLAUDE_MD")
        # Entfernt (a) den Marker-Block und (b) Alt-Kopien AUSSERHALB der Marker samt der
        # unmittelbar davor stehenden Ueberschrift. Fuer (b) wird eine Ueberschrift
        # zurueckgehalten und nur ausgegeben, wenn NICHT die Anweisungszeile folgt.
        # awk vergleicht den Marker exakt ($0 == m), nicht als Regex — safe fuer jeden Inhalt.
        CLEANED=$(printf '%s\n' "$ORIGINAL" | awk -v m="$MARKER" -v q="$QUESTION" '
            function flush() { if (held != "") { print held; held = "" } }
            $0 == m { in_block = !in_block; next }
            in_block { next }
            index($0, q) > 0 { held = ""; next }
            /^#+[ \t]*kw\/OS Workitem Tracking/ { flush(); held = $0; next }
            { flush(); print }
            END { flush() }
        ')
        printf '%s\n\n%s\n' "$CLEANED" "$INSTRUCTION" > "$CLAUDE_MD" 2>/dev/null
    else
        printf '%s\n' "$INSTRUCTION" > "$CLAUDE_MD" 2>/dev/null
    fi

    mkdir -p "$KWOS_DIR"
    cp -f "$SCRIPT_DIR/langfuse-hook.sh"     "$KWOS_DIR/" 2>/dev/null
    cp -f "$SCRIPT_DIR/inject-session-id.sh" "$KWOS_DIR/" 2>/dev/null
    chmod +x "$KWOS_DIR/langfuse-hook.sh" "$KWOS_DIR/inject-session-id.sh" 2>/dev/null
fi

# ── 2. Server call (session registration + carry lookup) ─────────────────────

# GRENZE, hier wichtig: dieser Call braucht KWOS_HOOKS_SECRET, und das kommt aus den
# server-managed remote-settings. Die werden bei gesetztem ANTHROPIC_BASE_URL NICHT ausgeliefert
# (2026-08-05 gemessen: in kwclaude-Sessions sind KWOS_HOOKS_SECRET/ENABLE_LSP_TOOL/
# CLAUDE_CODE_SUBAGENT_MODEL leer, in plain claude gesetzt). In kwclaude-Sessions schlaegt die
# Registrierung deshalb STILL fehl (curl -sf) -> es gibt keine OTEL-Session-ID und keinen Carry.
# Genau darum darf die Instruktion oben die Session-ID nicht voraussetzen: ein Agent, der sie
# sucht, greppt sonst minutenlang durch das Dateisystem (gemeldet 2026-08-05).
# Kostenattribution ist davon NICHT betroffen -- die macht der Gateway serverseitig.
PLUGIN_URL="${KWOS_PLUGIN_URL%/}"
if [ -n "$PLUGIN_URL" ]; then
    RESPONSE=$(printf '%s' "$BODY" | curl -sf -X POST "${PLUGIN_URL}/hooks/session-start" \
        -H 'Content-Type: application/json' \
        -H "X-Hook-Secret: ${KWOS_HOOKS_SECRET}" \
        --data @- 2>/dev/null)
    [ -n "$RESPONSE" ] && printf '%s' "$RESPONSE"
fi

# Die Bedingung SICHTBAR machen: der Agent kann Umgebungsvariablen nicht lesen, und ihn dafuer
# eine Shell aufrufen zu lassen ist verboten (Workitem = immer deferred MCP-Tool). Gemeldet
# 2026-08-05: mit der Bedingung "wenn KWOS_WORKITEM gesetzt ist" fragte der Agent stattdessen
# zurueck, OB die Session ueber kwclaude laeuft -- schlimmer als die alte Rueckfrage.
# Der Hook kennt die Variable und schreibt sie deshalb in den Kontext.
if [ -n "${KWOS_WORKITEM:-}" ]; then
    printf '%s\n' "" "[kraftwerkOS] WORKITEM BOUND: $KWOS_WORKITEM"
fi
exit 0
