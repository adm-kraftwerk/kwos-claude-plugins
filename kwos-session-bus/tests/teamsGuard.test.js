import test from "node:test";
import assert from "node:assert/strict";

import { DENIAL, MS365_SEND, hookAnswer } from "../server/teamsGuard.js";

// Where a message for another person goes (WI 11569154, measured 2026-10-29).
//
// The defect was not a missing rule -- the system prompt had one -- but that it was read at
// session start and the tool was picked an hour later. This hook sits at the tool itself:
// `permissionDecision: "deny"` STOPPED the call, and the reason reaches the model.

test("a Teams send is refused, and the refusal names the way that works", () => {
  const answer = hookAnswer("pretooluse", { tool_name: "mcp__ms365__send-chat-message" });
  assert.equal(answer?.hookSpecificOutput.permissionDecision, "deny");
  const reason = answer?.hookSpecificOutput.permissionDecisionReason;
  assert.equal(reason, DENIAL);
  // The sentence the user asked for: people in the collab are reached through the collab tools.
  assert.match(reason, /Personen im Collab erreichst du ueber die collab-Werkzeuge/);
  assert.match(reason, /collab_send/);
  // And the one case that stays the person's: a real message to a HUMAN.
  assert.match(reason, /frag deinen Nutzer/);
});

test("both ms365 send tools are covered, and nothing else is touched", () => {
  for (const name of ["mcp__ms365__send-chat-message", "mcp__ms365__send-channel-message"]) {
    assert.ok(MS365_SEND.test(name), name);
    assert.equal(hookAnswer("pretooluse", { tool_name: name })?.hookSpecificOutput.permissionDecision, "deny", name);
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

test("no other event carries a judgement -- the guard has one job", () => {
  assert.equal(hookAnswer("userpromptsubmit", {}), null);
  assert.equal(hookAnswer("sessionstart", {}), null);
  assert.equal(hookAnswer("", {}), null);
});
