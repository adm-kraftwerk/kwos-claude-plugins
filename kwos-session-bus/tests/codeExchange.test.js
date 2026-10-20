// kwcollab code exchange (WI 11517979): the flow functions against REAL repositories, with the relay
// replaced by an in-memory double that keeps exactly the state the flow reads back. Each test here
// reproduces a review finding of 2026-10-20 first, then holds the fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitText, readState, repoInfo } from "../server/codeGit.js";
import * as flow from "../server/codeExchange.js";

const COLLAB = "0c5d9b7e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";

async function world() {
  const root = mkdtempSync(join(tmpdir(), "kwcode-flow-"));
  const origin = join(root, "origin.git");
  await gitText(root, ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = join(root, "seed");
  await gitText(root, ["clone", "-q", "-c", "core.autocrlf=false", origin, seed]);
  writeFileSync(join(seed, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(seed, "b.txt"), "b\n");
  await gitText(seed, ["add", "-A"]);
  await gitText(seed, ["-c", "user.name=s", "-c", "user.email=s@x", "commit", "-q", "-m", "base"]);
  await gitText(seed, ["push", "-q", "origin", "HEAD:main"]);
  const me = join(root, "me");
  await gitText(root, ["clone", "-q", "-c", "core.autocrlf=false", origin, me]);
  await gitText(me, ["remote", "set-url", "origin", "https://git.example.com/t/p.git"]);
  await gitText(me, ["config", `url.${origin.replace(/\\/g, "/")}.insteadOf`, "https://git.example.com/t/p.git"]);
  const base = await gitText(seed, ["rev-parse", "HEAD"]);
  return { root, origin, seed, me, base, done: () => rmSync(root, { recursive: true, force: true }) };
}

// The relay as far as these flows touch it: the code state, the bundle and event posts.
function fakeRelay(state) {
  const posts = [];
  return {
    posts,
    state,
    get: async () => state,
    post: async (path, body) => { posts.push({ path, body }); return { conflict: null }; },
    put: async () => ({ mandate: { apply: "clean" } }),
    postRaw: async () => ({ bundle: { bundle_id: "11111111-2222-4333-8444-555555555555" } }),
    getRaw: async () => { throw new Error("no bundle in this test"); },
  };
}

test("rebase nach einem Checkpoint behaelt NICHT veroeffentlichte Aenderungen (Review-Fund 1)", async () => {
  const w = await world();
  try {
    const relay = fakeRelay({ code: { repo: "git.example.com/t/p", branch: "main", base: w.base }, members: [], bundles: [], conflicts: [] });
    await flow.join(relay, { cwd: w.me, collabId: COLLAB, me: "me", mandate: {} });
    writeFileSync(join(w.me, "a.txt"), "one\nTWO\nthree\n");
    await flow.publish(relay, { cwd: w.me, collabId: COLLAB, identity: { name: "me" }, sessionId: "s" });
    // After the publish: more work that nobody has seen yet.
    writeFileSync(join(w.me, "b.txt"), "b\nunpublished\n");
    writeFileSync(join(w.me, "new.txt"), "brand new\n");
    // Somebody else checkpoints a change of their own (not containing ours).
    writeFileSync(join(w.seed, "c.txt"), "from the checkpoint\n");
    await gitText(w.seed, ["add", "-A"]);
    await gitText(w.seed, ["-c", "user.name=s", "-c", "user.email=s@x", "commit", "-q", "-m", "cp"]);
    await gitText(w.seed, ["push", "-q", "origin", "HEAD:main"]);
    relay.state.code.base = await gitText(w.seed, ["rev-parse", "HEAD"]);

    const r = await flow.rebase(relay, { cwd: w.me, collabId: COLLAB, me: "me" });
    assert.equal(r.moved, true);
    assert.equal(r.clean, true);
    assert.equal(readFileSync(join(w.me, "a.txt"), "utf8"), "one\nTWO\nthree\n", "published edit kept");
    assert.equal(readFileSync(join(w.me, "b.txt"), "utf8"), "b\nunpublished\n", "UNPUBLISHED edit kept");
    assert.equal(readFileSync(join(w.me, "new.txt"), "utf8"), "brand new\n", "untracked new file kept");
    assert.equal(readFileSync(join(w.me, "c.txt"), "utf8"), "from the checkpoint\n", "checkpoint's file arrived");
    assert.equal(await gitText(w.me, ["rev-parse", "HEAD"]), relay.state.code.base);
  } finally { w.done(); }
});

test("solange Konfliktmarker im Worktree stehen, wird nichts veroeffentlicht -- nur resolved() darf (Review-Fund 2)", async () => {
  const w = await world();
  try {
    const relay = fakeRelay({ code: { repo: "git.example.com/t/p", branch: "main", base: w.base }, members: [], bundles: [], conflicts: [] });
    await flow.join(relay, { cwd: w.me, collabId: COLLAB, me: "me", mandate: {} });
    const { gitDir } = await repoInfo(w.me);
    const st = readState(gitDir);
    // The state sync leaves behind when this worktree resolves a conflict.
    const { writeState } = await import("../server/codeGit.js");
    writeState(gitDir, { ...st, conflicts: [{ member: "kai", head: w.base, paths: ["a.txt"] }] });
    writeFileSync(join(w.me, "a.txt"), "<<<<<<< ours\none\n=======\nONE\n>>>>>>> theirs\n");
    const held = await flow.publish(relay, { cwd: w.me, collabId: COLLAB, identity: { name: "me" }, sessionId: "s" });
    assert.equal(held.published, false);
    assert.deepEqual(held.held, ["kai"]);
    assert.equal(relay.posts.length, 0, "nothing reached the relay");
    await assert.rejects(() => flow.resolved(relay, { cwd: w.me, collabId: COLLAB, identity: { name: "me" }, sessionId: "s" }), /Konfliktmarker/);
    writeFileSync(join(w.me, "a.txt"), "one and ONE\n");
    const done = await flow.resolved(relay, { cwd: w.me, collabId: COLLAB, identity: { name: "me" }, sessionId: "s" });
    assert.equal(done.published, true);
    assert.deepEqual(done.resolved, ["kai"]);
  } finally { w.done(); }
});
