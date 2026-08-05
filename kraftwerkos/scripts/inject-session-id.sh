#!/bin/sh
# inject-session-id.sh — Claude Code UserPromptSubmit hook (macOS / Linux)
#
# Fires on the first user prompt of each session to inject the real Claude Code
# session ID into the conversation via additionalContext. A flag file gates this
# to a single injection per session — subsequent prompts exit in ~1ms.
#
# This script is purely local: no network calls, no prompt content leaves the machine.

INPUT=$(cat) || exit 0

SESSION_ID=$(printf '%s' "$INPUT" | grep -o '"session_id":"[^"]*"' | sed 's/"session_id":"//;s/"$//')
[ -z "$SESSION_ID" ] && exit 0

KWOS_DIR="$HOME/.kwos"
FLAG="$KWOS_DIR/injected-$SESSION_ID"

# Already injected this session — exit immediately
[ -f "$FLAG" ] && exit 0

mkdir -p "$KWOS_DIR"
printf '' > "$FLAG"

# Output additionalContext for Claude
printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"[kraftwerkOS] Session ID: %s. No workitem associated yet. Ask which kw/OS workitem the user is working on. Then use ToolSearch with query \\"setSessionWorkitem\\" to load the MCP tool schema, and call it with sessionId=\\"%s\\" and their workitemId. Never use Bash or shell scripts to set the workitem — it is always a deferred MCP tool."}}\n' \
    "$SESSION_ID" "$SESSION_ID"
