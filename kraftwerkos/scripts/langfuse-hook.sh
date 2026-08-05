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
    INPUT_TOKENS=$(grep -o '"input_tokens":[0-9]*' "$TRANSCRIPT" \
        | awk -F: '{sum+=$2} END{print sum+0}')
    OUTPUT_TOKENS=$(grep -o '"output_tokens":[0-9]*' "$TRANSCRIPT" \
        | awk -F: '{sum+=$2} END{print sum+0}')
    CACHE_CREATION_TOKENS=$(grep -o '"cache_creation_input_tokens":[0-9]*' "$TRANSCRIPT" \
        | awk -F: '{sum+=$2} END{print sum+0}')
    CACHE_READ_TOKENS=$(grep -o '"cache_read_input_tokens":[0-9]*' "$TRANSCRIPT" \
        | awk -F: '{sum+=$2} END{print sum+0}')
    # Keep latest model seen in the transcript
    MODEL=$(grep -o '"model":"[^"]*"' "$TRANSCRIPT" \
        | tail -1 | sed 's/"model":"//;s/"$//')
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
