import test from "node:test";
import assert from "node:assert/strict";

// A person may have several agents in one channel, each in its own repository. These tests hold the
// rules that keep two agents of ONE person from talking past each other (review findings on the
// agent model): who wakes whom, and which code plane a worktree belongs to.

process.env.KWOS_XID_ACCESS_TOKEN = "test-token";
process.env.KWOS_CLIENT_ID = "test-client";
const { frameToLine, mentionsSession } = await import("../server/collab-listen.js");
const flow = await import("../server/codeExchange.js");

const SELF = "aaaa1111-2222-3333-4444-555566667777";
const SIBLING = "bbbb1111-2222-3333-4444-555566667777";
const frame = (seq, text, kind = "claude") => JSON.stringify({
  seq, collab_id: "c-1", from_subject: "cberg", from_session: SIBLING, author_kind: kind, text,
});
const OPTS = { selfSessionId: SELF, selfSubject: "cberg", selfRepo: "git.supinfo.de/bc/bc", collabId: "c-1" };

test("a sibling agent does not wake this one, neither its agent lines nor the person's lines there", () => {
  assert.equal(frameToLine(frame(1, "Stand im STREAM-Repo"), OPTS), null);
  // A sentence the person typed in the OTHER pane belongs to that pane's agent.
  assert.equal(frameToLine(frame(2, "ein Satz im anderen Fenster", "human"), OPTS), null);
});

test("naming this agent the way the mark shows it DOES wake it", () => {
  // The mark is `Name @<repo> #<short id>`; a reader quotes what it sees.
  assert.ok(frameToLine(frame(3, "#aaaa1111 kannst du das im BC-Repo pruefen?"), OPTS));
  assert.ok(frameToLine(frame(4, "@bc bitte uebernehmen"), OPTS));
  assert.equal(mentionsSession("@bcx hat recht", SELF, "git.supinfo.de/bc/bc"), false, "@bc must not match inside @bcx");
  assert.equal(mentionsSession("#cccc1111", SELF, null), false);
  // An id that goes on with word characters past the eighth still matches by its short form.
  assert.equal(mentionsSession("frag #mobile-1 mal", "mobile-1234-abcd", null), true);
});

test("a worktree's plane is chosen by repository AND branch -- several projects per channel", () => {
  const cur = {
    code: { repo: "h/stream", branch: "main", base: "a".repeat(40) },
    planes: [
      { id: "p1", repo: "h/stream", branch: "main", base: "a".repeat(40) },
      { id: "p2", repo: "h/bc", branch: "feature/x", base: "b".repeat(40) },
      { id: "p3", repo: "h/bc", branch: "feature/y", base: "c".repeat(40) },
    ],
  };
  assert.equal(flow.planeForWorktree(cur, "h/stream", "main").id, "p1");
  assert.equal(flow.planeForWorktree(cur, "h/bc", "feature/y").id, "p3");
  // Two planes on one repository and an unknown branch: ambiguous, so none -- never a guess.
  assert.equal(flow.planeForWorktree(cur, "h/bc", "feature/z"), null);
  assert.equal(flow.planeForWorktree(cur, "h/other", "main"), null);
  // An older relay answers only `code`.
  assert.equal(flow.planeForWorktree({ code: cur.code }, "h/stream", "main").repo, "h/stream");
});
