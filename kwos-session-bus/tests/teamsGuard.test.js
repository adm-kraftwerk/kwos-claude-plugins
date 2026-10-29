import test from "node:test";
import assert from "node:assert/strict";

import { MS365_SEND, NOTE, hookAnswer } from "../server/teamsGuard.js";

// Where a message for another person goes (WI 11569154, measured 2026-10-29).
//
// A NUDGE, NOT A GATE (Steffen, 2026-10-29): Teams stays available, above all for a message to
// a HUMAN (external recipient, announcement). So the hook does not decide -- it notes, after
// the send, which way the next one should take. `additionalContext` reaches the model; no
// permissionDecision is ever returned.

test("after a Teams send the model reads where the next one belongs", () => {
  const answer = hookAnswer("posttooluse", { tool_name: "mcp__ms365__send-chat-message" });
  assert.equal(answer?.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.equal(answer?.hookSpecificOutput.additionalContext, NOTE);
  // No decision at all: the call already happened and nothing may be blocked.
  assert.equal(answer?.hookSpecificOutput.permissionDecision, undefined);
  // The three claims that make the note useful.
  assert.match(NOTE, /collab_send/);
  assert.match(NOTE, /Diese Zeile ist raus/);
  assert.match(NOTE, /bleibt Teams richtig/);
});

test("both ms365 send tools are covered, and nothing else is touched", () => {
  for (const name of ["mcp__ms365__send-chat-message", "mcp__ms365__send-channel-message"]) {
    assert.ok(MS365_SEND.test(name), name);
    assert.equal(hookAnswer("posttooluse", { tool_name: name })?.hookSpecificOutput.additionalContext, NOTE, name);
  }
  for (const name of [
    "mcp__ms365__list-chats",
    "mcp__ms365__send-mail",
    "mcp__ms365__send-chat-message-draft",
    "Bash",
    "",
  ]) {
    assert.equal(hookAnswer("posttooluse", { tool_name: name }), null, name);
  }
  assert.equal(hookAnswer("posttooluse", { tool_name: null }), null);
  assert.equal(hookAnswer("posttooluse", {}), null);
});

test("no other event carries an answer -- and in particular no PreToolUse decision", () => {
  // The old shape was a `deny` at PreToolUse. It must not come back by accident: Teams is the
  // right tool for a message to a human, and a gate would have made it unreachable.
  assert.equal(hookAnswer("pretooluse", { tool_name: "mcp__ms365__send-chat-message" }), null);
  assert.equal(hookAnswer("userpromptsubmit", {}), null);
  assert.equal(hookAnswer("sessionstart", {}), null);
  assert.equal(hookAnswer("", {}), null);
});
