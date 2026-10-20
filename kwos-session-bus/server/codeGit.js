// kwcollab code exchange (WI 11517979) -- the git side, on THIS machine.
//
// One session's working state becomes a commit under refs/kwcollab/<collab>/out, built with a
// PRIVATE index and `git commit-tree`: no commit on the branch, no hook, the user's index and HEAD
// untouched. Another session's state is fetched into refs/kwcollab/<collab>/in/<member> and merged
// with `git merge-tree --write-tree` (in memory); only the result is written into the worktree, with
// `git read-tree -m -u` against the private index. HEAD and the user's staging area never move.
//
// Every function here takes the repository directory and returns data; none of them talks to the
// relay. That keeps this file testable against real repositories (tests/codeGit.test.js) and puts
// the network in exactly one place (codeExchange.js).

import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { join, isAbsolute } from "node:path";

// git >= 2.40: `merge-tree --write-tree` with `--merge-base` and `--name-only` is what the merge
// needs (2.38 introduced --write-tree, 2.40 --merge-base). Older git is refused loudly -- a merge
// that silently does not happen is the failure this feature must never have.
export const GIT_MIN = [2, 40];

const NUL = "\u0000";

/**
 * Run git. Resolves `{ code, stdout, stderr }`; never throws on a non-zero exit (the callers decide
 * what a code means -- merge-tree's 1 is "conflicts", not an error). Throws only when git cannot be
 * started at all.
 *
 * `env` is merged over a CLEANED environment: an ambient GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE
 * (a hook's environment, a test runner) would point every command at the wrong repository.
 */
export function git(cwd, args, { env = {}, input, maxBuffer = 64 * 1024 * 1024, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const base = { ...process.env };
    for (const k of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_PREFIX", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"]) delete base[k];
    const child = spawn("git", args, {
      cwd,
      env: { ...base, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const out = [];
    const err = [];
    let size = 0;
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill(); }, timeoutMs);
    child.stdout.on("data", (c) => {
      size += c.length;
      if (size > maxBuffer) { killed = true; child.kill(); return; }
      out.push(c);
    });
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out);
      const stderr = Buffer.concat(err).toString("utf8");
      if (killed) return resolve({ code: -1, stdout, stderr: stderr || "git was stopped (timeout or output limit)" });
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** git, expecting exit 0; the trimmed stdout as text. */
export async function gitText(cwd, args, opts) {
  const r = await git(cwd, args, opts);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed (${r.code}): ${r.stderr.trim().split("\n").slice(-3).join(" ")}`);
  return r.stdout.toString("utf8").trim();
}

/** "git version 2.42.0.windows.1" -> [2, 42, 0]; null when unreadable. */
export function parseGitVersion(text) {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

export async function checkGitVersion(cwd) {
  const v = parseGitVersion(await gitText(cwd, ["--version"]));
  if (!v || v[0] < GIT_MIN[0] || (v[0] === GIT_MIN[0] && v[1] < GIT_MIN[1])) {
    throw new Error(`git ${GIT_MIN.join(".")} oder neuer wird gebraucht (gefunden: ${v ? v.join(".") : "unbekannt"}).`);
  }
  return v;
}

/**
 * The remote URL as the key the relay stores: `host[:port]/path`, lower-case host, no scheme, no
 * credentials, no trailing `.git`. https and ssh spellings of one remote give the same key -- two
 * people with different clone URLs work on the same repository.
 */
export function repoKey(url) {
  const s = String(url || "").trim();
  let host;
  let port = "";
  let path;
  let m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::(\d+))?\/(.+)$/i.exec(s);
  if (m) {
    [, host, port = "", path] = m;
    // An ssh URL's port is the ssh port, not part of the repository's identity.
    if (/^ssh:|^git:/i.test(s)) port = "";
  } else {
    m = /^(?:[^@/]+@)?([^/:]+):(?!\/\/)(.+)$/.exec(s);   // scp-like: git@host:group/repo.git
    if (!m) return null;
    [, host, path] = m;
  }
  path = path.replace(/\/+$/, "").replace(/\.git$/i, "");
  if (!path || path.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  return `${host.toLowerCase()}${port ? `:${port}` : ""}/${path}`;
}

/** The facts of the repository a session works in. */
export async function repoInfo(cwd) {
  const top = await gitText(cwd, ["rev-parse", "--show-toplevel"]);
  const gitDir = await gitText(top, ["rev-parse", "--absolute-git-dir"]);
  const head = await gitText(top, ["rev-parse", "--verify", "HEAD"]);
  const branchR = await git(top, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = branchR.code === 0 ? branchR.stdout.toString("utf8").trim() : null;
  // The CONFIGURED url, not `remote get-url`: that one applies `url.<x>.insteadOf`, and a local
  // mirror rewrite must not change which repository this is.
  const urlR = await git(top, ["config", "--get", "remote.origin.url"]);
  const url = urlR.code === 0 ? urlR.stdout.toString("utf8").trim() : null;
  return { top, gitDir, head, branch, repo: url ? repoKey(url) : null };
}

// ── Local state (one file per worktree, next to its own index) ─────────────────────────────

export function stateDir(gitDir) { return join(gitDir, "kwcollab"); }
const statePath = (gitDir) => join(stateDir(gitDir), "state.json");

export function readState(gitDir) {
  try { return JSON.parse(readFileSync(statePath(gitDir), "utf8")); } catch { return null; }
}

// Written through a temp file and a rename: a crash in the middle leaves the old state, never half
// of a JSON document that the next turn would read as "no state".
export function writeState(gitDir, state) {
  mkdirSync(stateDir(gitDir), { recursive: true });
  const tmp = `${statePath(gitDir)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, statePath(gitDir));
}

// Values that come from the relay become ref names and file names here. The relay constrains them
// (collab: UUID, member: [A-Za-z0-9._@-]), and so does this file -- a client must not hand path or
// ref control to whatever answers on the other side (review finding 2026-10-20).
const COLLAB_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEMBER_RE = /^[A-Za-z0-9_@-][A-Za-z0-9._@-]{0,127}$/;
export function checkCollabId(c) {
  if (!COLLAB_RE.test(String(c))) throw new Error(`collab id invalid: ${String(c).slice(0, 40)}`);
  return c;
}
export function checkMember(m) {
  const s = String(m);
  if (!MEMBER_RE.test(s) || s.includes("..") || s.endsWith(".lock") || s.endsWith(".")) throw new Error(`member invalid: ${s.slice(0, 40)}`);
  return s;
}
export const outRef = (collab) => `refs/kwcollab/${checkCollabId(collab)}/out`;
export const inRef = (collab, member) => `refs/kwcollab/${checkCollabId(collab)}/in/${checkMember(member)}`;

// ── Snapshot ────────────────────────────────────────────────────────────────────────────────

// Files larger than this are left out of a snapshot unless they are already tracked at the base:
// a build artefact or a dump would otherwise travel to every member, and the bundle limit (4 MB)
// would refuse the whole snapshot for one file.
export const SNAPSHOT_FILE_MAX = 1024 * 1024;

const IGNORE_FILE = ".kwcollabignore";

/**
 * The tree of the whole worktree as it is NOW -- tracked changes, untracked files (minus .gitignore
 * and .kwcollabignore), deletions -- written with a private index. Returns `{ tree, skipped }`.
 */
export async function worktreeTree(top, gitDir) {
  mkdirSync(stateDir(gitDir), { recursive: true });
  const env = { GIT_INDEX_FILE: join(stateDir(gitDir), "index") };
  // Seed the private index from HEAD so `add -A` only has to look at what changed.
  await gitText(top, ["read-tree", "HEAD"], { env });
  const extra = existsSync(join(top, IGNORE_FILE)) ? [`--exclude-from=${IGNORE_FILE}`] : [];
  // "Untracked" relative to the PRIVATE index (= HEAD): a file the user only staged is not in HEAD,
  // and asking the user's index would leave it out of the snapshot (found by the test that stages one).
  const listed = await git(top, ["ls-files", "-z", "--others", "--exclude-standard", ...extra], { env });
  if (listed.code !== 0) throw new Error(`git ls-files failed: ${listed.stderr.trim()}`);
  const untracked = listed.stdout.toString("utf8").split(NUL).filter(Boolean);
  const skipped = [];
  const take = [];
  for (const p of untracked) {
    let size = 0;
    try { size = statSync(join(top, p)).size; } catch { continue; }
    if (size > SNAPSHOT_FILE_MAX) skipped.push(p);
    else take.push(p);
  }
  // Tracked changes and deletions: `add -u` covers exactly the files HEAD knows.
  await gitText(top, ["add", "-u", "--", "."], { env });
  if (take.length > 0) {
    await gitText(top, ["add", "--pathspec-from-file=-", "--pathspec-file-nul"], { env, input: take.join(NUL) + NUL });
  }
  // .kwcollabignore also applies to TRACKED files (a local config the repo tracks with a template):
  // they keep the base's content in the snapshot.
  if (extra.length > 0) {
    const ign = await git(top, ["ls-files", "-z", "--cached", "--ignored", ...extra], { env });
    const paths = ign.stdout.toString("utf8").split(NUL).filter(Boolean);
    if (paths.length > 0) {
      await gitText(top, ["reset", "-q", "HEAD", "--pathspec-from-file=-", "--pathspec-file-nul"], { env, input: paths.join(NUL) + NUL });
    }
  }
  const tree = await gitText(top, ["write-tree"], { env });
  return { tree, skipped };
}

/** The changes between two trees/commits as the relay's file list. */
export async function changedFiles(top, from, to) {
  const ns = await git(top, ["diff", "--no-ext-diff", "--no-renames", "-z", "--name-status", from, to]);
  if (ns.code !== 0) throw new Error(`git diff failed: ${ns.stderr.trim()}`);
  const parts = ns.stdout.toString("utf8").split(NUL).filter((x) => x !== "");
  const files = new Map();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i][0];
    files.set(parts[i + 1], { path: parts[i + 1], status: "AMDT".includes(status) ? status : "M", add: null, del: null });
  }
  const nums = await git(top, ["diff", "--no-ext-diff", "--no-renames", "-z", "--numstat", from, to]);
  for (const rec of nums.stdout.toString("utf8").split(NUL)) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(rec);
    if (!m) continue;
    const f = files.get(m[3]);
    if (!f) continue;
    f.add = m[1] === "-" ? null : Number(m[1]);
    f.del = m[2] === "-" ? null : Number(m[2]);
  }
  return [...files.values()];
}

/**
 * Build a snapshot commit of the worktree. `parents` are the previous snapshot (or the base) plus
 * the foreign snapshots integrated since -- that is what lets git find the right merge base later,
 * with three members as with two. Returns `{ head, tree, changed }`; `changed` is false when the
 * tree equals the previous snapshot's (nothing to publish).
 */
export async function buildSnapshot(top, gitDir, { collab, base, parents, identity }) {
  const { tree, skipped } = await worktreeTree(top, gitDir);
  const prev = parents[0];
  const prevTree = await gitText(top, ["rev-parse", `${prev}^{tree}`]);
  if (tree === prevTree && parents.length === 1) return { head: prev, tree, changed: false, skipped };
  const env = {
    GIT_AUTHOR_NAME: identity?.name || "kwcollab",
    GIT_AUTHOR_EMAIL: identity?.email || "kwcollab@localhost",
    GIT_COMMITTER_NAME: identity?.name || "kwcollab",
    GIT_COMMITTER_EMAIL: identity?.email || "kwcollab@localhost",
  };
  const args = ["commit-tree", tree];
  for (const p of parents) args.push("-p", p);
  args.push("-m", `kwcollab snapshot (${collab})\n\nbase ${base}`);
  const head = await gitText(top, args, { env });
  return { head, tree, changed: true, skipped };
}

// ── Secrets ─────────────────────────────────────────────────────────────────────────────────

// The same classes as kwterm/wire's looksLikeSecret (litellm repo), applied to the ADDED lines of
// the diff that would leave this machine. A hit blocks the publish and names file and line.
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bxai-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function mask(line) {
  return line.replace(/([A-Za-z0-9._~+/-]{4})[A-Za-z0-9._~+/=-]{8,}/g, "$1********");
}

/** Added lines between `from` and `to` that look like credentials: [{ path, line, text }]. */
export async function findSecrets(top, from, to) {
  const r = await git(top, ["diff", "--no-ext-diff", "--no-color", "-U0", "--text", from, to]);
  if (r.code !== 0) throw new Error(`git diff failed: ${r.stderr.trim()}`);
  const hits = [];
  let path = null;
  let line = 0;
  // A file header is `--- a/x` followed by `+++ b/x`, and only OUTSIDE a hunk. Inside a hunk a
  // content line `++ x` reads as `+++ x` and must stay content -- treating it as a header switched
  // the scan off for the rest of the file (review finding 2026-10-20). So: headers only between
  // `diff --git` and the first `@@`, and hunk lines counted against the hunk's own line count.
  let inHeader = false;
  let left = 0;
  for (const raw of r.stdout.toString("utf8").split("\n")) {
    if (left === 0 && raw.startsWith("diff --git ")) { inHeader = true; path = null; continue; }
    if (inHeader && raw.startsWith("+++ ")) { path = raw.startsWith("+++ b/") ? raw.slice(6) : null; continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (hunk && left === 0) {
      inHeader = false;
      line = Number(hunk[1]);
      left = hunk[2] === undefined ? 1 : Number(hunk[2]);
      continue;
    }
    if (inHeader) continue;
    if (raw.startsWith("+") && path && left > 0) {
      left--;
      const text = raw.slice(1);
      if (SECRET_PATTERNS.some((re) => re.test(text))) hits.push({ path, line, text: mask(text).slice(0, 160) });
      line++;
    }
  }
  return hits;
}

// ── Bundles ─────────────────────────────────────────────────────────────────────────────────

/** A bundle with everything from `base` to `head` (the ref outRef(collab)), as bytes. */
export async function createBundle(top, collab, base) {
  const r = await git(top, ["bundle", "create", "-", outRef(collab), `^${base}`]);
  if (r.code !== 0) throw new Error(`git bundle create failed: ${r.stderr.trim()}`);
  return r.stdout;
}

/** Store a received bundle in the object database and point inRef(collab, member) at its head. */
export async function importBundle(top, gitDir, collab, member, bytes) {
  mkdirSync(stateDir(gitDir), { recursive: true });
  const file = join(stateDir(gitDir), `in-${checkMember(member)}.bundle`);
  writeFileSync(file, bytes);
  const v = await git(top, ["bundle", "verify", "-q", file]);
  if (v.code !== 0) throw new Error(`Bundle von ${member} passt nicht auf diesen Stand: ${v.stderr.trim().split("\n").slice(-1)[0]}`);
  const r = await git(top, ["fetch", "-q", "--no-tags", "--no-write-fetch-head", file, `+${outRef(collab)}:${inRef(collab, member)}`]);
  if (r.code !== 0) throw new Error(`git fetch aus dem Bundle schlug fehl: ${r.stderr.trim()}`);
  return gitText(top, ["rev-parse", inRef(collab, member)]);
}

// ── Merge ───────────────────────────────────────────────────────────────────────────────────

/**
 * Merge `theirs` into `ours` in memory. Returns `{ clean, tree, conflicts }` -- `tree` holds the
 * result (with conflict markers in the conflicting files when not clean), `conflicts` the paths.
 */
export async function mergeTrees(top, ours, theirs) {
  const r = await git(top, ["merge-tree", "--write-tree", "--name-only", "-z", "--no-messages", ours, theirs]);
  if (r.code !== 0 && r.code !== 1) throw new Error(`git merge-tree failed (${r.code}): ${r.stderr.trim()}`);
  const parts = r.stdout.toString("utf8").split(NUL);
  const tree = parts[0].trim();
  const conflicts = [...new Set(parts.slice(1).map((p) => p.trim()).filter(Boolean))];
  return { clean: r.code === 0, tree, conflicts };
}

/** Is `ancestor` reachable from `descendant`? */
export async function isAncestor(top, ancestor, descendant) {
  const r = await git(top, ["merge-base", "--is-ancestor", ancestor, descendant]);
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  throw new Error(`git merge-base failed: ${r.stderr.trim()}`);
}

/**
 * Write `targetTree` into the worktree, moving it from `fromTree` (what the worktree held when the
 * merge started). Only the paths that differ between the two are touched -- the user's index and
 * HEAD stay as they are.
 *
 * RACE GUARD: when the worktree no longer equals `fromTree` (the user or an agent edited a file
 * while the merge ran), nothing is written and `{ applied: false }` comes back; the caller tries
 * again on the next turn. `read-tree -m -u` would refuse an overwrite anyway; checking first gives
 * a clean answer instead of a half-applied tree.
 */
export async function applyTree(top, gitDir, fromTree, targetTree) {
  const now = await worktreeTree(top, gitDir);
  if (now.tree !== fromTree) return { applied: false, reason: "worktree changed while merging" };
  const env = { GIT_INDEX_FILE: join(stateDir(gitDir), "index") };
  // The private index holds fromTree (worktreeTree just wrote it); -m -u moves files to targetTree.
  const r = await git(top, ["read-tree", "-m", "-u", fromTree, targetTree], { env });
  if (r.code !== 0) return { applied: false, reason: r.stderr.trim() || "read-tree refused" };
  return { applied: true };
}

/** Paths in the worktree that still contain conflict markers. */
export async function filesWithMarkers(top, paths) {
  const left = [];
  for (const p of paths) {
    const full = isAbsolute(p) ? p : join(top, p);
    let text = "";
    try { text = readFileSync(full, "utf8"); } catch { continue; }
    if (/^<{7}( |$)/m.test(text) && /^>{7}( |$)/m.test(text)) left.push(p);
  }
  return left;
}

/** Simple glob match for mandate areas: `**` any depth, `*` within a segment, `?` one character. */
export function globMatch(glob, path) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(path);
}

export const inArea = (area, path) => (area || []).some((g) => globMatch(g, path));
