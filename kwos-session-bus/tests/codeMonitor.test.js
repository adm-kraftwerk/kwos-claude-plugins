// kwcollab code exchange (WI 11517979 + WI 11523603) -- the monitor's LOCAL half: which worktree
// does it inspect at all?
//
// `collab-listen` hands `codeServing` the value config.js read at start (bb3ae03), and that value is
// null where the process could not report its working directory. A null cwd is not "the process's
// directory": spawnSync then runs git where the PROCESS stands, and that is the repair directory
// config.js chdirs to for exactly this case ($HOME, $TMPDIR, /). The local test would read whatever
// kwcollab/state.json happens to lie there and could start serving another repository's snapshots,
// so the answer for null has to be "no worktree" (server/codeMonitor.js).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

process.env.KWOS_XID_ACCESS_TOKEN = "test-token";
const { codeServing } = await import("../server/codeMonitor.js");
const { installFetchMock } = await import("./helpers/fetch-mock.js");

const COLLAB = "7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c";

// A `git` that is not git: it records the directory it was started in and fails. That is the only
// way to tell "asked git" from "did not ask git" -- the module's answer is the same null either way.
function fakeGit(bin, marker) {
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$PWD" >> "$KWOS_TEST_GIT_MARKER"\nexit 1\n`, "utf8");
  chmodSync(join(bin, "git"), 0o755);
  return marker;
}

test("no worktree: the monitor's local test starts no process at all", async () => {
  const bin = mkdtempSync(join(tmpdir(), "kwmonitor-bin-"));
  const marker = fakeGit(bin, join(bin, "called"));
  const worktree = mkdtempSync(join(tmpdir(), "kwmonitor-worktree-"));
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path}`;
  process.env.KWOS_TEST_GIT_MARKER = marker;
  try {
    await codeServing({ cwd: null }).refresh(COLLAB, {});
    assert.ok(!existsSync(marker), "ohne Worktree wurde trotzdem git gestartet");

    // The control: with a cwd the same double IS called, in THAT directory. Without it this test
    // would also pass for a mechanism that never runs (the "skip is no gate" trap).
    await codeServing({ cwd: worktree }).refresh(COLLAB, {});
    assert.ok(existsSync(marker), "die Attrappe wurde nie aufgerufen -- der Test waere leer");
    assert.equal(realpathSync(readFileSync(marker, "utf8").trim()), realpathSync(worktree));
  } finally {
    process.env.PATH = path;
    delete process.env.KWOS_TEST_GIT_MARKER;
    rmSync(worktree, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test("no worktree: the fallback directory is not read and the relay is not asked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwmonitor-fallback-"));
  const previous = process.cwd();
  const mock = installFetchMock(() => Promise.resolve({
    ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({}),
  }));
  const serving = codeServing({ cwd: null });
  process.chdir(dir);   // whatever a null cwd falls back to is the directory the process stands in
  try {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(join(dir, ".git", "kwcollab"), { recursive: true });
    writeFileSync(join(dir, ".git", "kwcollab", "state.json"), JSON.stringify({ collab: COLLAB, me: "u-mara" }), "utf8");
    // The fixture must be one the UNFIXED code would have found: a real repository, in code mode for
    // exactly this collab, right where a null cwd lands. Otherwise this test asserts nothing.
    const gitDir = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: process.cwd(), encoding: "utf8" }).stdout.trim();
    assert.equal(gitDir, join(realpathSync(dir), ".git"), "die Attrappe liegt nicht dort, wo ein null-cwd landet");

    const entry = {};
    await serving.refresh(COLLAB, entry);
    assert.deepEqual(mock.calls, [], "ohne Worktree wurde das Ausweichverzeichnis geprueft und der Relay gefragt");
    assert.equal(entry.wake, undefined, "ohne Worktree wird kein Mandat gelesen");
  } finally {
    // Registered no matter what the assertion above said: without the fix this call STARTED serving
    // and its back channel would keep the process (and the suite) alive -- a gate that hangs is no
    // gate.
    serving.drop(COLLAB);
    process.chdir(previous);
    mock.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});
