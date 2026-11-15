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
SENTINEL='kw/OS Workitem Tracking (v6)'

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
workitem is already settled for this session: it was given on the \`kwclaude\` command line and
travels to the gateway in a request header. Then do NOTHING about workitem tracking — do not ask,
do not call setSessionWorkitem, do not look for a session ID, and do not mention any of this.
Just answer the user.
Otherwise (plain \`claude\`, no gateway) ask once \"${QUESTION}?\", then
use ToolSearch with query \"setSessionWorkitem\" to load the MCP tool schema and call it with their
workitemId and the session ID from your context. Never use Bash or shell scripts to set the
workitem — it is always a deferred MCP tool. Only ask once per session.
A workitem CARRIED OVER from an earlier session is NOT a reason to skip the question: offer it as
the default, but still ask — otherwise today's work books onto yesterday's workitem.
${MARKER}"

# ── 1. Local setup ────────────────────────────────────────────────────────────

# `grep -c` gibt bei null Treffern "0" aus UND endet mit 1 -- ein `|| printf '0'` haengt dann ein
# zweites "0" an, und `[ "0\n0" -eq 2 ]` scheitert mit "integer expression expected" (Meldung bei
# jedem Start auf einer Maschine ohne Marker). Darum wird der Wert normalisiert, statt `||` zu nutzen.
count_lines() {  # file -> Anzahl Treffer als reine Zahl
    _n=$(grep -cF "$1" "$2" 2>/dev/null)
    case "${_n:-}" in
        ''|*[!0-9]*) printf '0' ;;
        *) printf '%s' "$_n" ;;
    esac
}
MARKER_COUNT=$(count_lines "$MARKER" "$CLAUDE_MD")
HAS_SENTINEL=$(count_lines "$SENTINEL" "$CLAUDE_MD")
# Genau EINE Kopie der Anweisung ist der Sollzustand. Mehr heisst: es liegen ALT-KOPIEN ausserhalb
# der Marker herum (aus der Zeit vor den Markern). Die widersprechen dem aktuellen Block -- die
# alte Fassung ist kategorisch formuliert und gewinnt, dadurch fragte kwclaude weiter nach dem
# Workitem, obwohl der neue Block das ausschliesst (gemeldet 2026-08-05 von einem WSL-Client).
QUESTION_COUNT=$(count_lines "$QUESTION" "$CLAUDE_MD")

# DIE DATEI GEHOERT DEM NUTZER -- SIE WIRD NIE AUF VERDACHT UMGESCHRIEBEN.
# `$CLAUDE_MD` traegt alle globalen Regeln des Menschen. Ueberschrieben wird nur, wenn der Zustand
# BEKANNT ist: kein Marker oder ein PAAR Marker. Ein UNPAARIGER Marker heisst, dass etwas mit der
# Datei passiert ist, was dieses Skript nicht kennt (Editor hat eine Kommentarzeile verschluckt,
# abgebrochener Schreibvorgang, von Hand geloescht) -- dann bliebe vom Reiniger alles bis Dateiende
# auf der Strecke, ohne Sicherung und ohne Meldung. In dem Fall wird die Datei unangetastet
# gelassen, und der Grund steht auf stderr.
_kl_md_write() {  # inhalt -> atomar in $CLAUDE_MD (temp + rename), mit EINER Sicherung
    _dir=$(dirname "$CLAUDE_MD")
    mkdir -p "$_dir" 2>/dev/null || return 1
    printf '%s' "$1" > "$CLAUDE_MD.kwos.$$" 2>/dev/null || return 1
    if [ -f "$CLAUDE_MD" ] && [ ! -f "$CLAUDE_MD.kwos.bak" ]; then
        cp -p "$CLAUDE_MD" "$CLAUDE_MD.kwos.bak" 2>/dev/null
    fi
    mv -f "$CLAUDE_MD.kwos.$$" "$CLAUDE_MD" 2>/dev/null || { rm -f "$CLAUDE_MD.kwos.$$" 2>/dev/null; return 1; }
}

_kl_hook_same() {  # quelle ziel -> 0, wenn die Kopie aktuell ist (Inhalt, nicht Existenz)
    [ -f "$2" ] && cmp -s "$1" "$2"
}

_kl_md_ok=1
if [ -f "$CLAUDE_MD" ]; then
    case "$MARKER_COUNT" in
        0|2) ;;
        *)
            _kl_md_ok=0
            echo "[kraftwerkOS] $CLAUDE_MD hat $MARKER_COUNT statt zwei Markern -- sie wird NICHT angefasst." >&2
            echo "  Zwei Zeilen '<!-- kraftwerkOS -->' gehoeren um den Block. Bitte von Hand wiederherstellen." >&2
            ;;
    esac
fi

if [ "$_kl_md_ok" = "1" ] && ! ([ "$MARKER_COUNT" -eq 2 ] && \
      [ "$HAS_SENTINEL" -ge 1 ] && \
      [ "$QUESTION_COUNT" -eq 1 ] && \
      _kl_hook_same "$SCRIPT_DIR/langfuse-hook.sh"     "$KWOS_DIR/langfuse-hook.sh" && \
      _kl_hook_same "$SCRIPT_DIR/inject-session-id.sh" "$KWOS_DIR/inject-session-id.sh"); then

    if [ -f "$CLAUDE_MD" ]; then
        ORIGINAL=$(cat "$CLAUDE_MD")
        # Entfernt (a) den Marker-Block und (b) Alt-Kopien AUSSERHALB der Marker samt der
        # unmittelbar davor stehenden Ueberschrift. Fuer (b) wird eine Ueberschrift
        # zurueckgehalten und nur ausgegeben, wenn NICHT die Anweisungszeile folgt.
        # awk vergleicht den Marker exakt ($0 == m), nicht als Regex — safe fuer jeden Inhalt.
        # `held != ""` vor der Anweisungszeile: eine NUTZERZEILE, die den Satz zitiert, wird nur
        # dann verworfen, wenn sie unter der alten Ueberschrift steht -- nicht ueberall in der Datei.
        CLEANED=$(printf '%s\n' "$ORIGINAL" | awk -v m="$MARKER" -v q="$QUESTION" '
            function flush() { if (held != "") { print held; held = "" } }
            $0 == m { in_block = !in_block; next }
            in_block { next }
            held != "" && index($0, q) > 0 { held = ""; next }
            /^#+[ \t]*kw\/OS Workitem Tracking/ { flush(); held = $0; next }
            { flush(); print }
            END { flush() }
        ')
        _kl_md_write "$(printf '%s\n\n%s\n' "$CLEANED" "$INSTRUCTION")"
    else
        _kl_md_write "$(printf '%s\n' "$INSTRUCTION")"
    fi

    mkdir -p "$KWOS_DIR"
    # INHALT statt Existenz: ein Update der Hooks muss auch bei Clients ankommen, die die Datei
    # schon haben -- sonst rechnet die Flotte dauerhaft mit dem alten Kosten-Skript.
    _kl_hook_same "$SCRIPT_DIR/langfuse-hook.sh" "$KWOS_DIR/langfuse-hook.sh" \
        || cp -f "$SCRIPT_DIR/langfuse-hook.sh" "$KWOS_DIR/" 2>/dev/null
    _kl_hook_same "$SCRIPT_DIR/inject-session-id.sh" "$KWOS_DIR/inject-session-id.sh" \
        || cp -f "$SCRIPT_DIR/inject-session-id.sh" "$KWOS_DIR/" 2>/dev/null
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
    # Die Frist bleibt UNTER dem `timeout` in hooks.json (10 s). Ohne sie wartet curl beim
    # Verbindungsaufbau bis zu 300 s, der Client bricht den Hook nach 10 s ab -- und die Zeile
    # "[kraftwerkOS] WORKITEM BOUND: …" hinter diesem Aufruf erreicht den Kontext dann nicht mehr.
    RESPONSE=$(printf '%s' "$BODY" | curl -sf --connect-timeout 2 -m 3 -X POST "${PLUGIN_URL}/hooks/session-start" \
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
