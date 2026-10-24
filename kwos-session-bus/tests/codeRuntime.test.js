// kwcollab code exchange: the parts that read the relay's code state for THIS address. Two
// sessions of one person may be on two projects, so an entry is only ours when its session id is
// ours -- a sibling's mandate, plane and head are not answers for this session.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFetchMock } from "./helpers/fetch-mock.js";

process.env.KWOS_XID_ACCESS_TOKEN = "test-token";
process.env.KWOS_CLIENT_ID = "test-client";
const { config } = await import("../server/config.js");
const { codeContext } = await import("../server/codeRuntime.js");
const { wakeFromCode } = await import("../server/codeMonitor.js");

config.sessionId = config.sessionId ?? "s-me";

const COLLAB = "7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c";

const jsonResponse = (body, status = 200) =>
  Promise.resolve({
    ok: status < 400,
    status,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify(body),
    json: async () => body,
  });

const channel = {
  collab_id: COLLAB,
  workitem: "11551159",
  title: "Sitzungen",
  my_status: "joined",
  members: [{
    subject: "me", display_name: "Me", status: "joined",
    sessions: [{ session_id: config.sessionId }, { session_id: "s-sibling" }],
  }],
};

/** Serve the channel list and a code state; every request is captured. */
function mockRelay(members) {
  return installFetchMock((url) => {
    if (url.endsWith("/v1/collabs")) return jsonResponse({ collabs: [channel] });
    if (url.includes("/code")) {
      return jsonResponse({
        code: { repo: "git.example.com/t/p", branch: "main", base: "b" },
        members,
        bundles: [],
        conflicts: [],
        questions: [],
      });
    }
    return jsonResponse({}, 404);
  });
}

async function tempDir() {
  return mkdtempSync(join(tmpdir(), "kwcollab-runtime-"));
}

test("codeContext: mandate and state come from THIS address", async () => {
  const dir = await tempDir();
  const mock = mockRelay([
    { subject: "me", session_id: "s-sibling", head: "sib", mandate: { apply: "never", wake: false } },
    { subject: "me", session_id: config.sessionId, head: "own", mandate: { apply: "resolve", wake: false } },
  ]);
  try {
    const ctx = await codeContext({ cwd: dir, collabId: COLLAB });
    assert.equal(ctx.joined, true);
    assert.equal(ctx.me, "me");
    assert.equal(ctx.mandate.apply, "resolve", "not the sibling's mandate");
    assert.equal(ctx.mandate.wake, false);
    assert.ok(
      mock.calls.some((c) => c.url.includes(`/code?session=${config.sessionId}`)),
      "the own session must be named in the request",
    );
  } finally { mock.restore(); rmSync(dir, { recursive: true, force: true }); }
});

test("codeContext: a session that is not on a plane is NOT joined -- no fallback", async () => {
  const dir = await tempDir();
  const mock = mockRelay([
    { subject: "me", session_id: "s-sibling", head: "sib", mandate: { apply: "never", wake: false } },
  ]);
  try {
    const ctx = await codeContext({ cwd: dir, collabId: COLLAB });
    assert.equal(ctx.joined, false);
    assert.equal(ctx.active, false);
    assert.equal(ctx.mandate, null);
  } finally { mock.restore(); rmSync(dir, { recursive: true, force: true }); }
});

test("wakeFromCode: only the mandate of this address counts", () => {
  const own = { members: [{ subject: "me", session_id: "s-me", mandate: { wake: false } }] };
  assert.equal(wakeFromCode(own, "me", "s-me"), false);
  assert.equal(wakeFromCode({ members: [{ subject: "me", session_id: "s-me", mandate: {} }] }, "me", "s-me"), true);
  const sibling = { members: [{ subject: "me", session_id: "s-other", mandate: { wake: false } }] };
  assert.equal(wakeFromCode(sibling, "me", "s-me"), true, "a sibling must not silence this session");
});
