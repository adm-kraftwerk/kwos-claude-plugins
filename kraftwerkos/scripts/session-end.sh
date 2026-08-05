#!/bin/sh
# session-end.sh — Claude Code SessionEnd command hook
# Forwards session-end event to the plugin server so it can store carry state
# (workitem_id keyed by hash(cwd)) for persistence across /clear sessions.

BODY=$(cat)
PLUGIN_URL="${KWOS_PLUGIN_URL%/}"
[ -z "$PLUGIN_URL" ] && exit 0
printf '%s' "$BODY" | curl -sf -X POST "${PLUGIN_URL}/hooks/session-end" \
    -H 'Content-Type: application/json' \
    -H "X-Hook-Secret: ${KWOS_HOOKS_SECRET}" \
    --data @- 2>/dev/null
exit 0
