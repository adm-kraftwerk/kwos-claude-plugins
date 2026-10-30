import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { HINT, MS365_SEND, hookAnswer } from "../server/teamsGuard.js";

// Where a message for another person goes (WI 11569154, measured 2026-10-29).
//
// The hint must arrive BEFORE the send and decide nothing: Teams stays available, above all for
// a message to a human (external recipient, announcement). `additionalContext` on PreToolUse is
// the one shape that does both -- measured against client 2.1.312 with a probe session: the
// model read the injected marker and still performed the call.

// THE NAME THE FLEET ACTUALLY SEES (measured 2026-10-30, client 2.1.312). The ms365 server is
// declared in `kraftwerkos/.mcp.json`; the client scopes a plugin-bundled MCP server's name
// segment by plugin, so these are the tool names, and `mcp__ms365__...` does not exist here. The
// first version of this PR matched the bare key on both layers -- matcher and regex -- and would
// have been silent in every session.
const FLEET_NAMES = [
  "mcp__plugin_kraftwerkos_ms365__send-chat-message",
  "mcp__plugin_kraftwerkos_ms365__send-channel-message",
];
// The same tool as a user-scope or project-scope `ms365` server spells it.
const BARE_NAMES = ["mcp__ms365__send-chat-message", "mcp__ms365__send-channel-message"];

test("before the send the model reads where the next one belongs -- if this session is in a channel", () => {
  const answer = hookAnswer("pretooluse", { tool_name: FLEET_NAMES[0] }, true);
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

test("NOBODY OUTSIDE A CHANNEL GETS THE HINT (Steffen, 2026-10-29)", () => {
  // The question is not "does this session have the plugin" but "is it a member of an open
  // channel". Everything else -- no channel, an unanswered relay, an older build -- is quiet.
  const payload = { tool_name: FLEET_NAMES[0] };
  assert.equal(hookAnswer("pretooluse", payload, false), null);
  assert.equal(hookAnswer("pretooluse", payload, undefined), null);
  assert.equal(hookAnswer("pretooluse", payload, null), null);
  // Only the literal `true` counts (an older/foreign caller cannot switch it on by accident).
  assert.equal(hookAnswer("pretooluse", payload, "true"), null);
});

test("both ms365 send tools are covered, and nothing else is touched", () => {
  for (const name of [...FLEET_NAMES, ...BARE_NAMES]) {
    assert.ok(MS365_SEND.test(name), name);
    assert.equal(hookAnswer("pretooluse", { tool_name: name }, true)?.hookSpecificOutput.additionalContext, HINT, name);
  }
  for (const name of [
    "mcp__ms365__list-chats",
    "mcp__ms365__send-mail",
    "mcp__ms365__send-chat-message-draft",
    "mcp__plugin_kraftwerkos_ms365__send-mail",
    // The plugin segment has to name a PLUGIN, not carry anything -- a matcher that swallowed
    // arbitrary text would also fire for a server called `plugin_x_ms365` that only looks similar.
    "mcp__something_ms365__send-chat-message",
    "Bash",
    "",
  ]) {
    assert.equal(hookAnswer("pretooluse", { tool_name: name }, true), null, name);
  }
  assert.equal(hookAnswer("pretooluse", { tool_name: null }, true), null);
  assert.equal(hookAnswer("pretooluse", {}, true), null);
});

test("the hook's own matcher fires for the name the fleet sends (the two layers must agree)", () => {
  // THE LAYER THAT CANNOT BE TESTED BY CALLING `hookAnswer`: a matcher that does not fire means
  // the hook process never starts, and no unit test of the answer would notice. Measured
  // 2026-10-30: the first version matched `mcp__ms365__...` in `hooks.json` AND in `MS365_SEND`,
  // both silent, and every test was green because the payloads carried the same wrong name.
  const cfg = JSON.parse(readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8"));
  // THE ENTRY THAT RUNS THIS HOOK, not every PreToolUse matcher: another entry covers
  // `Edit|Write|...`, and asking it about a Teams tool name says nothing.
  const entry = cfg.hooks.PreToolUse.find((e) => JSON.stringify(e.hooks).includes("teams-guard.js"));
  assert.ok(entry, "hooks.json hat keinen PreToolUse-Eintrag fuer teams-guard.js");
  const matcher = entry.matcher;
  assert.equal(typeof matcher, "string");
  // Unanchored, like the client reads it.
  const fires = (name) => new RegExp(matcher).test(name);
  for (const name of [...FLEET_NAMES, ...BARE_NAMES]) assert.ok(fires(name), `${name} wird vom Teams-Matcher nicht erfasst`);
  for (const name of ["mcp__ms365__send-mail", "mcp__plugin_kraftwerkos_ms365__list-chats", "Edit"]) {
    assert.ok(!fires(name), `${name} soll den Teams-Hook nicht starten`);
  }
});

test("no other event carries an answer -- and never a stop", () => {
  // The first shape was a `deny`. It must not come back by accident: Teams is the right tool
  // for a message to a human, and a gate would have made it unreachable.
  for (const event of ["posttooluse", "userpromptsubmit", "sessionstart", ""]) {
    assert.equal(hookAnswer(event, { tool_name: FLEET_NAMES[0] }), null, event);
  }
});
