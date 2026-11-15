#!/bin/sh
# session-end.sh — Claude Code SessionEnd command hook
# Forwards session-end event to the plugin server so it can store carry state
# (workitem_id keyed by hash(cwd)) for persistence across /clear sessions.

BODY=$(cat)
PLUGIN_URL="${KWOS_PLUGIN_URL%/}"
[ -z "$PLUGIN_URL" ] && exit 0
# Die Frist ist ABSICHTLICH kuerzer als das `timeout` in hooks.json (10 s): der Client bricht den
# Hook nach dieser Grenze ab, und die Zeile danach (`exit 0`) ist dann vertan. Ein Hook, der einen
# Sitzungsstart oder ein -ende aufhaelt, weil ein Host schwarze Loecher wirft, ist schlimmer als
# eine verlorene Meldung -- der Carry-Zustand geht dann beim naechsten Start neu auf.
printf '%s' "$BODY" | curl -sf --connect-timeout 2 -m 3 -X POST "${PLUGIN_URL}/hooks/session-end" \
    -H 'Content-Type: application/json' \
    -H "X-Hook-Secret: ${KWOS_HOOKS_SECRET}" \
    --data @- 2>/dev/null
exit 0
