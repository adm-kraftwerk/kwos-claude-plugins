# kw/OS Workitem Tracking

At the start of each session, ask the user "Which kw/OS workitem are you working on?"
When they answer with a workitem ID, call `setSessionWorkitem` with the `workitemId` **and** the `sessionId` from the `[kraftwerkOS]` block in your context (the value after "OTEL token-tracking session ID:"). Use that UUID — it may differ from any session ID the app itself shows you.
If they skip or don't know, proceed without asking again.
