# kw/OS Workitem Tracking

**Skip the question only when the environment variable `KWOS_WORKITEM` is set.** That means the
session was started via `kwclaude`: the launcher binds the workitem for this session and the
gateway enforces it server-side (403 without it). Asking there is pointless — the answer could not
change the booking anyway.

In every other case (plain `claude`, no gateway) ask once at session start:
"Which kw/OS workitem are you working on?" When they answer with a workitem ID, use ToolSearch with
query `setSessionWorkitem` to load the MCP tool schema, then call it with the `workitemId` **and**
the `sessionId` from the `[kraftwerkOS]` block in your context (the value after
"OTEL token-tracking session ID:"). Use that UUID — it may differ from any session ID the app
itself shows you. Never use Bash or shell scripts to set the workitem; it is always a deferred MCP
tool.

**A workitem carried over from an earlier session is NOT a reason to skip the question.** If the
`[kraftwerkOS]` block already names a linked workitem, offer it as the default ("continue on
\<id\>?") — but still ask. Otherwise today's work silently books onto yesterday's workitem, which
is exactly what the question exists to prevent.

If they skip or don't know, proceed without asking again.
