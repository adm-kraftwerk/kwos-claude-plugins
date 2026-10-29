import test from "node:test";
import assert from "node:assert/strict";

import { HINT, MS365_SEND, hookAnswer } from "../server/teamsGuard.js";

// Where a message for another person goes (WI 11569154, measured 2026-10-29).
//
// The hint must arrive BEFORE the send and decide nothing: Teams stays available, above all for
// a message to a human (external recipient, announcement). `additionalContext` on PreToolUse is
// the one shape that does both -- measured against client 2.1.312 with a probe session: the
// model read the injected marker and still performed the call.

test("before the send the model reads where the next one belongs", () => {
  const answer = hookAnswer("pretooluse", { tool_name: "mcp__ms365__send-chat-message" });
  assert.equal(answer?.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(answer?.hookSpecificOutput.additionalContext, HINT);
  // Nothing is decided: no permissionDecision, no updatedInput.
  assert.equal(answer?.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(answer?.hookSpecificOutput.updatedInput, undefined);
});

test("the hint names the channel AND the case where Teams is right", () => {
  // Without the second half the note would push an announcement or a customer message away
  // from the tool that belongs to it.
  assert.match(HINT, /collab_send/);
  assert.match(HINT, /externer Empfaenger, Ankuendigung, Zustellnachweis/);
  assert.match(HINT, /dann sende wie geplant/);
  // And it is a hint, not a reprimand: it never scolds a send that already happened.
  assert.doesNotMatch(HINT, /war falsch|falsch gemacht/i);
});

test("both ms365 send tools are covered, and nothing else is touched", () => {
  for (const name of ["mcp__ms365__send-chat-message", "mcp__ms365__send-channel-message"]) {
    assert.ok(MS365_SEND.test(name), name);
    assert.equal(hookAnswer("pretooluse", { tool_name: name })?.hookSpecificOutput.additionalContext, HINT, name);
  }
  for (const name of [
    "mcp__ms365__list-chats",
    "mcp__ms365__send-mail",
    "mcp__ms365__send-chat-message-draft",
    "Bash",
    "",
  ]) {
    assert.equal(hookAnswer("pretooluse", { tool_name: name }), null, name);
  }
  assert.equal(hookAnswer("pretooluse", { tool_name: null }), null);
  assert.equal(hookAnswer("pretooluse", {}), null);
});

test("no other event carries an answer -- and never a stop", () => {
  // The first shape was a `deny`. It must not come back by accident: Teams is the right tool
  // for a message to a human, and a gate would have made it unreachable.
  for (const event of ["posttooluse", "userpromptsubmit", "sessionstart", ""]) {
    assert.equal(hookAnswer(event, { tool_name: "mcp__ms365__send-chat-message" }), null, event);
  }
});
