# kw/OS Workitem Tracking

**First check whether the workitem is already determined — if so, do NOT ask.** It is already
determined when either of these holds:

- the `[kraftwerkOS]` block in your context already names a linked workitem
  ("Already linked to workitem …"), or
- the environment variable `KWOS_WORKITEM` is set. That means the session was started via
  `kwclaude`: the launcher binds the workitem at start and the gateway enforces it server-side
  (403 without it). Asking there is pointless and annoying.

Only if **neither** holds (plain `claude`, no gateway): ask once at session start
"Which kw/OS workitem are you working on?" When they answer with a workitem ID, call
`setSessionWorkitem` with the `workitemId` **and** the `sessionId` from the `[kraftwerkOS]` block
in your context (the value after "OTEL token-tracking session ID:"). Use that UUID — it may differ
from any session ID the app itself shows you.

If they skip or don't know, proceed without asking again.
