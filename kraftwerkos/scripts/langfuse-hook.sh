#!/bin/sh
# langfuse-hook.sh — Claude Code Stop hook (macOS / Linux)
#
# Reads token counts from the transcript and POSTs them to the kw/OS plugin.
# The server enriches the data with workitem metadata and forwards to Langfuse.
#
# Required env vars (set via server-managed Claude Code settings):
#   KWOS_PLUGIN_URL    Base URL of the plugin server
#   KWOS_HOOKS_SECRET  Shared secret matching the plugin's KWOS_HOOKS_SECRET

# ── Read hook input from stdin ───────────────────────────────────────────────

INPUT=$(cat) || exit 0

# Guard: never trigger if another Stop hook is already active (prevents loops)
printf '%s' "$INPUT" | grep -q '"stop_hook_active":true' && exit 0

# Extract session_id
SESSION_ID=$(printf '%s' "$INPUT" | grep -o '"session_id":"[^"]*"' | sed 's/"session_id":"//;s/"$//')
[ -z "$SESSION_ID" ] && exit 0

# Skip trivial turns where Claude produced no response
printf '%s' "$INPUT" | grep -q '"last_assistant_message":""'  && exit 0
printf '%s' "$INPUT" | grep -q '"last_assistant_message"'     || exit 0

# Extract transcript path
TRANSCRIPT=$(printf '%s' "$INPUT" | grep -o '"transcript_path":"[^"]*"' | sed 's/"transcript_path":"//;s/"$//')

# ── Sum token counts from transcript (cumulative across all turns) ────────────
#
# The transcript is JSONL — one JSON record per line.
# grep -o extracts the FULL key:"value" pattern.
# Note: "input_tokens": will NOT match inside "cache_read_input_tokens": or
# "cache_creation_input_tokens": because those keys do not contain the literal
# substring `"input_tokens":` (the double-quote before 'input' is absent there).

INPUT_TOKENS=0
OUTPUT_TOKENS=0
CACHE_CREATION_TOKENS=0
CACHE_READ_TOKENS=0
MODEL=""

if [ -f "$TRANSCRIPT" ]; then
    # EIN Durchlauf, und zwar ueber die STRUKTUR statt ueber Zeichenketten.
    #
    # WARUM (gemessen an einer echten Sitzung, 291 MB): die frueheren fuenf `grep -o`-Laeufe
    # summierten JEDES Vorkommen von "input_tokens":N -- und die Transkripte fuehren denselben
    # Verbrauch in `message.usage` UND in `message.usage.iterations[]` noch einmal. Gemessen:
    # cache_creation exakt doppelt, output +40 %, cache_read +16 %. Die PowerShell-Fassung zaehlt
    # seit jeher nur die oberste Ebene; diese hier zieht jetzt nach.
    #
    # Ausserdem: `"model":"<synthetic>"` steht am Ende vieler Transkripte (Fehlermeldungen,
    # Kompaktierung). Der letzte Treffer war damit ein Modell, das es nicht gibt, und die Kosten
    # landeten unter einem erfundenen Namen. Gezaehlt wird das letzte ECHTE Modell.
    #
    # python3 statt awk: JSON mit verschachtelten Objekten ist mit Zeichenketten nicht zuverlaessig
    # zu lesen. Fehlt python3, bleibt es bei Nullen -- dieselbe Aussage wie eine fehlende Datei.
    _sums=$(python3 -c '
import json, sys
tot = {"input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}
model = ""
try:
    fh = open(sys.argv[1], encoding="utf-8", errors="replace")
except OSError:
    sys.exit(0)
with fh:
    for line in fh:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if rec.get("type") != "assistant":
            continue
        msg = rec.get("message") or {}
        name = msg.get("model")
        # "<synthetic>" ist eine lokale Zeile (Fehlermeldung, Kompaktierung) und traegt keinen
        # echten Verbrauch -- sie wird ganz uebersprungen, nicht nur der Name.
        if isinstance(name, str) and name.startswith("<"):
            continue
        if isinstance(name, str) and name:
            model = name
        usage = msg.get("usage")
        if isinstance(usage, dict):
            for key in tot:
                value = usage.get(key)
                if isinstance(value, int):
                    tot[key] += value
print(tot["input_tokens"], tot["output_tokens"], tot["cache_creation_input_tokens"],
      tot["cache_read_input_tokens"], model or "-")
' "$TRANSCRIPT" 2>/dev/null) || _sums=""
    if [ -n "$_sums" ]; then
        # set -- statt read: POSIX-sh hat keine here-strings, und die Werte sind Zahlen.
        set -- $_sums
        INPUT_TOKENS=${1:-0}
        OUTPUT_TOKENS=${2:-0}
        CACHE_CREATION_TOKENS=${3:-0}
        CACHE_READ_TOKENS=${4:-0}
        MODEL=${5:-}
        [ "$MODEL" = "-" ] && MODEL=""
    fi
fi

INPUT_TOKENS=${INPUT_TOKENS:-0}
OUTPUT_TOKENS=${OUTPUT_TOKENS:-0}
CACHE_CREATION_TOKENS=${CACHE_CREATION_TOKENS:-0}
CACHE_READ_TOKENS=${CACHE_READ_TOKENS:-0}

# ── POST to plugin ───────────────────────────────────────────────────────────

PLUGIN_URL="${KWOS_PLUGIN_URL%/}"
[ -z "$PLUGIN_URL" ] && exit 0

if [ -n "$MODEL" ]; then
    MODEL_JSON="\"$MODEL\""
else
    MODEL_JSON="null"
fi

PAYLOAD="{\"session_id\":\"$SESSION_ID\",\"input_tokens\":$INPUT_TOKENS,\"output_tokens\":$OUTPUT_TOKENS,\"cache_creation_tokens\":$CACHE_CREATION_TOKENS,\"cache_read_tokens\":$CACHE_READ_TOKENS,\"model\":$MODEL_JSON}"

if [ -n "$KWOS_HOOKS_SECRET" ]; then
    curl -s -m 5 -X POST \
        -H "Content-Type: application/json" \
        -H "X-Hook-Secret: $KWOS_HOOKS_SECRET" \
        -d "$PAYLOAD" \
        "$PLUGIN_URL/api/trace" >/dev/null 2>&1 || true
else
    curl -s -m 5 -X POST \
        -H "Content-Type: application/json" \
        -d "$PAYLOAD" \
        "$PLUGIN_URL/api/trace" >/dev/null 2>&1 || true
fi

exit 0
