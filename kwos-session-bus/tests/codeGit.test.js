// kwcollab code exchange (WI 11517979): the git side against REAL repositories in temp folders.
// No mocks -- what this file proves is what git does, which no mock can tell.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  git, gitText, parseGitVersion, repoKey, repoInfo, worktreeTree, buildSnapshot, changedFiles,
  findSecrets, mask, createBundle, importBundle, mergeTrees, applyTree, filesWithMarkers, globMatch,
  outRef, inRef, isAncestor, SNAPSHOT_FILE_MAX, writeState,
} from "../server/codeGit.js";

const ID = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
const COLLAB = "0c5d9b7e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";

function tmp(name) { return mkdtempSync(join(tmpdir(), `kwcode-${name}-`)); }

// origin (bare) with one commit, and N clones of it -- the shape of the real thing.
// `crlf` is the line-ending setting of the clones, applied BEFORE the checkout (`clone -c`): a
// Windows machine's global core.autocrlf=true would otherwise decide it, and the tests would test
// the machine they run on. Both settings are tested on purpose -- the fleet has both.
async function world(n = 2, { crlf = "false" } = {}) {
  const root = tmp("world");
  const origin = join(root, "origin.git");
  await gitText(root, ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = join(root, "seed");
  await gitText(root, ["clone", "-q", "-c", "core.autocrlf=false", origin, seed]);
  writeFileSync(join(seed, "a.txt"), "one\ntwo\nthree\nfour\nfive\n");
  writeFileSync(join(seed, "b.txt"), "b\n");
  writeFileSync(join(seed, ".gitignore"), "*.log\n");
  await gitText(seed, ["add", "-A"]);
  await gitText(seed, ["commit", "-q", "-m", "base"], { env: ID });
  await gitText(seed, ["push", "-q", "origin", "HEAD:main"]);
  const clones = [];
  for (let i = 0; i < n; i++) {
    const c = join(root, `c${i}`);
    const mode = Array.isArray(crlf) ? crlf[i] : crlf;
    await gitText(root, ["clone", "-q", "-c", `core.autocrlf=${mode}`, origin, c]);
    clones.push(c);
  }
  const base = await gitText(seed, ["rev-parse", "HEAD"]);
  return { root, origin, clones, base, done: () => rmSync(root, { recursive: true, force: true }) };
}

async function snap(dir, parents, base) {
  const info = await repoInfo(dir);
  const s = await buildSnapshot(info.top, info.gitDir, { collab: COLLAB, base, parents, identity: { name: "t" } });
  if (s.changed) await gitText(dir, ["update-ref", outRef(COLLAB), s.head]);
  return { ...s, info };
}

test("parseGitVersion liest die gängigen Formen", () => {
  assert.deepEqual(parseGitVersion("git version 2.42.0.windows.1"), [2, 42, 0]);
  assert.deepEqual(parseGitVersion("git version 2.40.1"), [2, 40, 1]);
  assert.equal(parseGitVersion("nope"), null);
});

test("repoKey macht aus https und ssh denselben Schluessel und laesst Zugangsdaten weg", () => {
  assert.equal(repoKey("https://user:tok@git.supinfo.de/claude/litellm.git"), "git.supinfo.de/claude/litellm");
  assert.equal(repoKey("git@git.supinfo.de:claude/litellm.git"), "git.supinfo.de/claude/litellm");
  assert.equal(repoKey("ssh://git@git.supinfo.de:2222/claude/litellm"), "git.supinfo.de/claude/litellm");
  assert.equal(repoKey("https://GitHub.com/adm-kraftwerk/kwos-claude-plugins/"), "github.com/adm-kraftwerk/kwos-claude-plugins");
  assert.equal(repoKey("https://git.example.com:8443/a/b"), "git.example.com:8443/a/b");
  assert.equal(repoKey("https://x/a/../b"), null);
  assert.equal(repoKey(""), null);
});

test("ein Snapshot erfasst Aenderung, Loeschung und neue Datei -- und laesst HEAD und Index des Nutzers in Ruhe", async () => {
  const w = await world(1);
  try {
    const [c] = w.clones;
    writeFileSync(join(c, "a.txt"), "one\ntwo\nTHREE\nfour\nfive\n");
    unlinkSync(join(c, "b.txt"));
    writeFileSync(join(c, "new.txt"), "new\n");
    writeFileSync(join(c, "debug.log"), "ignored\n");
    writeFileSync(join(c, "staged.txt"), "staged\n");
    await gitText(c, ["add", "staged.txt"]);
    const indexBefore = await gitText(c, ["diff", "--cached", "--name-only"]);
    const s = await snap(c, [w.base], w.base);
    assert.equal(s.changed, true);
    const files = await changedFiles(c, w.base, s.head);
    assert.deepEqual(files.map((f) => `${f.status} ${f.path}`).sort(), ["A new.txt", "A staged.txt", "D b.txt", "M a.txt"]);
    assert.deepEqual(files.find((f) => f.path === "a.txt"), { path: "a.txt", status: "M", add: 1, del: 1 });
    assert.equal(await gitText(c, ["rev-parse", "HEAD"]), w.base, "HEAD bewegt sich nicht");
    assert.equal(await gitText(c, ["diff", "--cached", "--name-only"]), indexBefore, "der Index des Nutzers bleibt");
    assert.equal(await gitText(c, ["log", "--oneline", "-1", "--format=%P", s.head]), w.base);
    // Nothing changed since: no new snapshot.
    const again = await snap(c, [s.head], w.base);
    assert.equal(again.changed, false);
  } finally { w.done(); }
});

test("grosse ungetrackte Dateien und .kwcollabignore bleiben draussen", async () => {
  const w = await world(1);
  try {
    const [c] = w.clones;
    writeFileSync(join(c, "big.bin"), Buffer.alloc(SNAPSHOT_FILE_MAX + 1));
    writeFileSync(join(c, ".kwcollabignore"), "local.env\n");
    writeFileSync(join(c, "local.env"), "x=1\n");
    const s = await snap(c, [w.base], w.base);
    assert.deepEqual(s.skipped, ["big.bin"]);
    const files = (await changedFiles(c, w.base, s.head)).map((f) => f.path);
    assert.ok(!files.includes("big.bin"));
    assert.ok(!files.includes("local.env"));
    assert.ok(files.includes(".kwcollabignore"));
  } finally { w.done(); }
});

test("Zugangsdaten im Diff werden gefunden, maskiert und mit Datei und Zeile genannt", async () => {
  const w = await world(1);
  try {
    const [c] = w.clones;
    writeFileSync(join(c, "cfg.js"), `const a = 1;\nconst key = "sk-${"x".repeat(30)}";\n`);
    const s = await snap(c, [w.base], w.base);
    const hits = await findSecrets(c, w.base, s.head);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].path, "cfg.js");
    assert.equal(hits[0].line, 2);
    assert.ok(!hits[0].text.includes("x".repeat(20)), "der Treffer ist maskiert");
    assert.equal(mask("token abcdefghijklmnop"), "token abcd********");
  } finally { w.done(); }
});

test("Bundle von A, Import bei B, sauberer Merge -- B bekommt A's Aenderung in den Worktree, HEAD bleibt", async () => {
  const w = await world(2);
  try {
    const [a, b] = w.clones;
    writeFileSync(join(a, "a.txt"), "ONE\ntwo\nthree\nfour\nfive\n");
    const sa = await snap(a, [w.base], w.base);
    const bytes = await createBundle(a, COLLAB, w.base);
    assert.ok(bytes.subarray(0, 16).toString("latin1").startsWith("# v2 git bundle\n"));

    writeFileSync(join(b, "a.txt"), "one\ntwo\nthree\nfour\nFIVE\n");
    const binfo = await repoInfo(b);
    const head = await importBundle(binfo.top, binfo.gitDir, COLLAB, "kai", bytes);
    assert.equal(head, sa.head);
    assert.equal(await gitText(b, ["rev-parse", inRef(COLLAB, "kai")]), sa.head);

    const sb = await snap(b, [w.base], w.base);
    const m = await mergeTrees(b, sb.head, head);
    assert.equal(m.clean, true);
    const r = await applyTree(binfo.top, binfo.gitDir, sb.tree, m.tree);
    assert.equal(r.applied, true);
    assert.equal(readFileSync(join(b, "a.txt"), "utf8"), "ONE\ntwo\nthree\nfour\nFIVE\n");
    assert.equal(await gitText(b, ["rev-parse", "HEAD"]), w.base);
  } finally { w.done(); }
});

test("Konflikt: merge-tree nennt die Datei, applyTree schreibt Konfliktmarker, filesWithMarkers findet sie", async () => {
  const w = await world(2);
  try {
    const [a, b] = w.clones;
    writeFileSync(join(a, "a.txt"), "one\ntwo\nA-THREE\nfour\nfive\n");
    const sa = await snap(a, [w.base], w.base);
    const bundle = await createBundle(a, COLLAB, w.base);
    writeFileSync(join(b, "a.txt"), "one\ntwo\nB-THREE\nfour\nfive\n");
    const binfo = await repoInfo(b);
    const theirs = await importBundle(binfo.top, binfo.gitDir, COLLAB, "kai", bundle);
    const sb = await snap(b, [w.base], w.base);
    const m = await mergeTrees(b, sb.head, theirs);
    assert.equal(m.clean, false);
    assert.deepEqual(m.conflicts, ["a.txt"]);
    const r = await applyTree(binfo.top, binfo.gitDir, sb.tree, m.tree);
    assert.equal(r.applied, true);
    const text = readFileSync(join(b, "a.txt"), "utf8");
    assert.match(text, /^<<<<<<< /m);
    assert.match(text, /B-THREE/);
    assert.match(text, /A-THREE/);
    assert.deepEqual(await filesWithMarkers(b, ["a.txt", "b.txt"]), ["a.txt"]);

    // Resolve, snapshot with both parents: the other side can then take it without a conflict.
    writeFileSync(join(b, "a.txt"), "one\ntwo\nAB-THREE\nfour\nfive\n");
    const resolved = await snap(b, [sb.head, theirs], w.base);
    assert.equal(await isAncestor(b, theirs, resolved.head), true);
    const back = await createBundle(b, COLLAB, w.base);
    const ainfo = await repoInfo(a);
    const got = await importBundle(ainfo.top, ainfo.gitDir, COLLAB, "tim", back);
    const sa2 = await snap(a, [sa.head], w.base);
    const m2 = await mergeTrees(a, sa2.head, got);
    assert.equal(m2.clean, true, "die Loesung laesst sich auf der anderen Seite ohne Konflikt uebernehmen");
    assert.equal(sa2.changed, false);
  } finally { w.done(); }
});

test("applyTree schreibt nichts, wenn der Worktree sich waehrend des Merges geaendert hat", async () => {
  const w = await world(2);
  try {
    const [a, b] = w.clones;
    writeFileSync(join(a, "b.txt"), "from a\n");
    await snap(a, [w.base], w.base);
    const binfo = await repoInfo(b);
    const theirs = await importBundle(binfo.top, binfo.gitDir, COLLAB, "kai", await createBundle(a, COLLAB, w.base));
    const sb = await snap(b, [w.base], w.base);
    const m = await mergeTrees(b, sb.head, theirs);
    writeFileSync(join(b, "a.txt"), "edited meanwhile\n");
    const r = await applyTree(binfo.top, binfo.gitDir, sb.tree, m.tree);
    assert.equal(r.applied, false);
    assert.equal(readFileSync(join(b, "b.txt"), "utf8"), "b\n", "nichts halb geschrieben");
    assert.equal(readFileSync(join(b, "a.txt"), "utf8"), "edited meanwhile\n");
  } finally { w.done(); }
});

test("drei Beteiligte: Git findet die Merge-Basis selbst ueber die Eltern-Verweise", async () => {
  const w = await world(3);
  try {
    const [a, b, c] = w.clones;
    writeFileSync(join(a, "a.txt"), "ONE\ntwo\nthree\nfour\nfive\n");
    const sa = await snap(a, [w.base], w.base);
    const fromA = await createBundle(a, COLLAB, w.base);
    // B takes A, adds own change, publishes with A as second parent.
    const binfo = await repoInfo(b);
    const ta = await importBundle(binfo.top, binfo.gitDir, COLLAB, "a", fromA);
    const sb0 = await snap(b, [w.base], w.base);
    const mb = await mergeTrees(b, sb0.head, ta);
    await applyTree(binfo.top, binfo.gitDir, sb0.tree, mb.tree);
    writeFileSync(join(b, "b.txt"), "B\n");
    const sb = await snap(b, [w.base, ta], w.base);
    const fromB = await createBundle(b, COLLAB, w.base);
    // C takes B first (which contains A), then A: A must be recognised as already contained.
    const cinfo = await repoInfo(c);
    const tb = await importBundle(cinfo.top, cinfo.gitDir, COLLAB, "b", fromB);
    const sc0 = await snap(c, [w.base], w.base);
    const mc = await mergeTrees(c, sc0.head, tb);
    assert.equal(mc.clean, true);
    await applyTree(cinfo.top, cinfo.gitDir, sc0.tree, mc.tree);
    const sc = await snap(c, [w.base, tb], w.base);
    const ta2 = await importBundle(cinfo.top, cinfo.gitDir, COLLAB, "a", fromA);
    assert.equal(ta2, sa.head);
    assert.equal(await isAncestor(c, ta2, sc.head), true, "A steckt in B und damit in C");
    assert.equal(readFileSync(join(c, "a.txt"), "utf8"), "ONE\ntwo\nthree\nfour\nfive\n");
    assert.equal(readFileSync(join(c, "b.txt"), "utf8"), "B\n");
    assert.ok(sb.changed);
  } finally { w.done(); }
});

test("Linux (LF) und Windows (autocrlf=true) tauschen aus, ohne dass Zeilenenden als Aenderung reisen", async () => {
  const w = await world(2, { crlf: ["false", "true"] });
  try {
    const [a, b] = w.clones;
    assert.equal(readFileSync(join(b, "a.txt"), "utf8"), "one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n");
    // A snapshot of an untouched CRLF checkout is no change at all.
    const idle = await snap(b, [w.base], w.base);
    assert.equal(idle.changed, false);
    writeFileSync(join(a, "b.txt"), "line1\nline2\n");
    await snap(a, [w.base], w.base);
    const binfo = await repoInfo(b);
    const theirs = await importBundle(binfo.top, binfo.gitDir, COLLAB, "a", await createBundle(a, COLLAB, w.base));
    const sb = await snap(b, [w.base], w.base);
    const m = await mergeTrees(b, sb.head, theirs);
    await applyTree(binfo.top, binfo.gitDir, sb.tree, m.tree);
    assert.equal(readFileSync(join(b, "b.txt"), "utf8"), "line1\r\nline2\r\n");
    // And the CRLF checkout is not a change of its own in the next snapshot.
    const after = await snap(b, [sb.head, theirs], w.base);
    const diff = await changedFiles(b, theirs, after.head);
    assert.deepEqual(diff, []);
  } finally { w.done(); }
});

test("ein Bundle, das nicht auf der Basis aufsetzt, wird laut abgelehnt", async () => {
  const w = await world(2);
  try {
    const [a, b] = w.clones;
    writeFileSync(join(a, "x.txt"), "x\n");
    await gitText(a, ["add", "-A"]);
    await gitText(a, ["commit", "-q", "-m", "local only"], { env: ID });
    const localBase = await gitText(a, ["rev-parse", "HEAD"]);
    writeFileSync(join(a, "y.txt"), "y\n");
    await snap(a, [localBase], localBase);
    const bytes = await createBundle(a, COLLAB, localBase);
    const binfo = await repoInfo(b);
    await assert.rejects(() => importBundle(binfo.top, binfo.gitDir, COLLAB, "a", bytes), /passt nicht/);
  } finally { w.done(); }
});

test("findSecrets: eine Inhaltszeile '++ x' schaltet die Suche fuer den Rest der Datei nicht ab", async () => {
  const w = await world(1);
  try {
    const [c] = w.clones;
    writeFileSync(join(c, "notes.md"), `intro\n++ looks like a header\nmore\nkey = "ghp_${"A".repeat(36)}"\n`);
    const s = await snap(c, [w.base], w.base);
    const hits = await findSecrets(c, w.base, s.head);
    assert.equal(hits.length, 1, "the credential after the '++' line is found");
    assert.equal(hits[0].path, "notes.md");
    assert.equal(hits[0].line, 4);
  } finally { w.done(); }
});

test("Werte vom Relay werden nicht ungeprueft zu Ref- und Dateinamen", async () => {
  assert.throws(() => outRef("../../x"), /collab id invalid/);
  assert.throws(() => inRef(COLLAB, "../evil"), /member invalid/);
  assert.throws(() => inRef(COLLAB, "a/b"), /member invalid/);
  assert.throws(() => inRef(COLLAB, "x.lock"), /member invalid/);
  assert.equal(inRef(COLLAB, "00gaa93b"), `refs/kwcollab/${COLLAB}/in/00gaa93b`);
});

test("globMatch versteht **, * und ?", () => {
  assert.equal(globMatch("relay/**", "relay/lib.js"), true);
  assert.equal(globMatch("relay/**", "relay/tests/a.test.js"), true);
  assert.equal(globMatch("relay/*.js", "relay/tests/a.js"), false);
  assert.equal(globMatch("**/*.md", "docs/x/readme.md"), true);
  assert.equal(globMatch("a?c", "abc"), true);
  assert.equal(globMatch("a.c", "abc"), false);
});

test("git() raeumt GIT_DIR aus der Umgebung weg", async () => {
  const w = await world(1);
  const prev = process.env.GIT_DIR;
  try {
    process.env.GIT_DIR = join(w.root, "nowhere");
    const r = await git(w.clones[0], ["rev-parse", "HEAD"]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.toString().trim(), w.base);
  } finally {
    if (prev === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prev;
    w.done();
  }
  assert.ok(!existsSync(w.root));
  mkdirSync(w.root, { recursive: true });
  rmSync(w.root, { recursive: true, force: true });
});
