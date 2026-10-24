// kwcollab code exchange (WI 11517979): the flow functions against REAL repositories, with the relay
// replaced by an in-memory double that keeps exactly the state the flow reads back. Each test here
// reproduces a review finding of 2026-10-20 first, then holds the fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitText, readState, repoInfo } from "../server/codeGit.js";
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
  const puts = [];
  const raws = [];
  const pulls = [];
  return {
    posts,
    puts,
    raws,
    pulls,
    state,
    get: async () => state,
    post: async (path, body) => { posts.push({ path, body }); return { conflict: null }; },
    put: async (path, body) => { puts.push({ path, body }); return { mandate: { apply: "clean" } }; },
    postRaw: async (path, bytes, headers) => {
      raws.push({ path, bytes, headers });
      return { bundle: { bundle_id: "11111111-2222-4333-8444-555555555555" } };
    },
    getRaw: async (path) => {
      const id = path.split("/").pop();
      pulls.push(id);
      if (state.rawBundles?.[id]) return state.rawBundles[id];
      throw new Error("no bundle in this test");
    },
  };
}

test("rebase nach einem Checkpoint behaelt NICHT veroeffentlichte Aenderungen (Review-Fund 1)", async () => {
  const w = await world();
  try {
    const relay = fakeRelay({ code: { repo: "git.example.com/t/p", branch: "main", base: w.base }, members: [], bundles: [], conflicts: [] });
    await flow.join(relay, { cwd: w.me, collabId: COLLAB, me: "me", mandate: {}, sessionId: "s-own" });
    assert.equal(relay.puts.at(-1).body.session_id, "s-own", "the join names this session");
    writeFileSync(join(w.me, "a.txt"), "one\nTWO\nthree\n");
    await flow.publish(relay, { cwd: w.me, collabId: COLLAB, identity: { name: "me" }, sessionId: "s-own" });
    // The bundle belongs to this ADDRESS: without the session the relay files it on the person.
    assert.match(relay.raws.at(-1).path, /\?session=s-own$/);
    assert.equal(relay.raws.at(-1).headers["X-Kwcollab-Session"], "s-own");
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

test("sync: each AGENT takes in its own state -- two sessions of one person do not collide", async () => {
  // Review finding: `members` and `bundles` were read per PERSON. Two sessions of one person on
  // one project were therefore filtered as "self"/looked up under one key, and one of their
  // snapshots could simply not be found. The relay names the SESSION everywhere now; the client
  // has to as well -- including across the person's own two addresses.
  const w = await world();
  try {
    const relay = fakeRelay({
      code: { repo: "git.example.com/t/p", branch: "main", base: w.base },
      members: [], bundles: [], conflicts: [],
    });
    await flow.join(relay, { cwd: w.me, collabId: COLLAB, me: "me", mandate: {}, sessionId: "s-me" });
    const out = `refs/kwcollab/${COLLAB}/out`;
    const bundleOf = async (head) => {
      await gitText(w.seed, ["update-ref", out, head]);
      const r = await git(w.seed, ["bundle", "create", "-", out, `^${w.base}`]);
      assert.equal(r.code, 0, r.stderr.toString());
      return r.stdout;
    };
    const commit = async (file, text) => {
      writeFileSync(join(w.seed, file), text);
      await gitText(w.seed, ["add", "-A"]);
      await gitText(w.seed, ["-c", "user.name=s", "-c", "user.email=s@x", "commit", "-q", "-m", file]);
      return gitText(w.seed, ["rev-parse", "HEAD"]);
    };
    const h1 = await commit("c.txt", "kai one\n");
    const h2 = await commit("d.txt", "kai two\n");
    const h3 = await commit("e.txt", "my other box\n");
    const [b1, b2, b3] = [await bundleOf(h1), await bundleOf(h2), await bundleOf(h3)];

    const id1 = "11111111-1111-4111-8111-111111111111";
    const id2 = "22222222-2222-4222-8222-222222222222";
    const id3 = "33333333-3333-4333-8333-333333333333";
    relay.state.members = [
      { subject: "me", session_id: "s-me", head: h1 },   // THIS address: never fetched, even with a head
      { subject: "kai", session_id: "k-1", head: h1, head_paths: ["c.txt"], online: false },
      { subject: "kai", session_id: "k-2", head: h2, head_paths: ["d.txt"], online: false },
      { subject: "me", session_id: "s-other", head: h3, head_paths: ["e.txt"], online: false },
    ];
    relay.state.bundles = [
      { bundle_id: id1, member: "kai", member_session: "k-1", head: h1 },
      { bundle_id: id2, member: "kai", member_session: "k-2", head: h2 },
      { bundle_id: id3, member: "me", member_session: "s-other", head: h3 },
    ];
    relay.state.rawBundles = { [id1]: b1, [id2]: b2, [id3]: b3 };

    const s = await flow.sync(relay, { cwd: w.me, collabId: COLLAB, me: "me", mandate: {}, sessionId: "s-me" });
    assert.equal(s.rebase, false);
    assert.deepEqual(s.report.map((r) => r.kind), ["integrated", "integrated", "integrated"]);
    assert.deepEqual(relay.pulls, [id1, id2, id3], "each address finds its own bundle");
    assert.equal(readFileSync(join(w.me, "c.txt"), "utf8"), "kai one\n");
    assert.equal(readFileSync(join(w.me, "d.txt"), "utf8"), "kai two\n");
    assert.equal(readFileSync(join(w.me, "e.txt"), "utf8"), "my other box\n");

    const integrated = relay.posts.filter((p) => p.body?.payload?.type === "integrated");
    assert.deepEqual(integrated.map((p) => [p.body.payload.from_member, p.body.payload.from_session]),
      [["kai", "k-1"], ["kai", "k-2"], ["me", "s-other"]]);

    const st = readState((await repoInfo(w.me)).gitDir);
    assert.equal(st.integrated["kai#k-1"], h1);
    assert.equal(st.integrated["kai#k-2"], h2);
    assert.equal(st.integrated["me#s-other"], h3);
    assert.equal(st.integrated["me"], undefined, "no entry under the bare person name");
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
