import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isMainModule } from "../server/is-main.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = join(here, "..", "server");
const pluginDir = join(here, "..");
const IS_MAIN_URL = pathToFileURL(join(serverDir, "is-main.js")).href;

function scratch() {
  return mkdtempSync(join(tmpdir(), "kwos-is-main-"));
}

// A directory link, spelled the way the platform allows WITHOUT privileges: Windows needs a
// junction (a real directory symlink demands developer mode or admin), POSIX takes "dir".
function linkDir(target, path) {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

test("the file node was started with is the entry point -- here this test file", () => {
  // `node --test` runs each test file as its own process, so argv[1] names it. The counterpart to
  // the case below: a module NAMED by argv[1] answers true, one merely imported by it does not.
  assert.equal(isMainModule(import.meta.url), true);
});

test("without the caller's own url there is no answer, and no quiet false", () => {
  // The trap this signature exists for: `import.meta.url` INSIDE the helper names the helper, so a
  // default would compare the guard's own path with argv[1] and answer false for every entry point.
  assert.throws(() => isMainModule(), /str|undefined|null/i);
});

test("started as the entry point, the module knows it", () => {
  const dir = scratch();
  const probe = join(dir, "probe.mjs");
  writeFileSync(
    probe,
    `import { isMainModule } from ${JSON.stringify(IS_MAIN_URL)};
     console.log(JSON.stringify({ viaDefault: isMainModule(import.meta.url) }));`,
    "utf8"
  );
  const out = execFileSync(process.execPath, [probe], { encoding: "utf8" });
  const r = JSON.parse(out.trim().split("\n").pop());

  assert.equal(r.viaDefault, true, "the started file IS the main module");
});

test("argv[1] naming another file is not main", () => {
  assert.equal(
    isMainModule(IS_MAIN_URL, {
      argv: [process.execPath, join(serverDir, "listen.js")],
    }),
    false
  );
});

test("without argv[1] nothing starts (an import, not a start)", () => {
  assert.equal(isMainModule(IS_MAIN_URL, { argv: [process.execPath] }), false);
  assert.equal(isMainModule(IS_MAIN_URL, { argv: [] }), false);
  assert.equal(isMainModule(IS_MAIN_URL, { argv: undefined }), false);
});

// WI 11550391, the defect this file exists for: a fleet install where ~/.claude/plugins is a
// symlink. `import.meta.url` carries the real path, `process.argv[1]` the path the caller named.
// Compared as strings, they differ -- and the process exited 0 with an empty stdout and stderr, so
// every session-bus tool was silently gone. Resolved on both sides, the symlink cannot matter.
test("a symlinked path to the same file still counts as main", (t) => {
  const root = scratch();
  const real = join(root, "real");
  mkdirSync(real);
  const entry = join(real, "entry.mjs");
  writeFileSync(entry, "", "utf8");
  const link = join(root, "link");
  try {
    linkDir(real, link);
  } catch (err) {
    t.skip(`this machine allows no directory link without privileges: ${err.code}`);
    return;
  }

  const argv = [process.execPath, join(link, "entry.mjs")];
  const moduleUrl = pathToFileURL(entry).href;

  assert.notEqual(join(link, "entry.mjs"), entry, "the two spellings really do differ");
  assert.equal(isMainModule(moduleUrl, { argv }), true, "same file, so main -- whatever the spelling");
});

test("a file that does not exist is not main, and the check does not throw", () => {
  const root = scratch();
  assert.equal(
    isMainModule(IS_MAIN_URL, { argv: [process.execPath, join(root, "gone.js")] }),
    false
  );
});

// The end-to-end guard: the real monitor, started the way Claude Code starts it, through a
// symlinked plugin directory. Before the fix this process returned within milliseconds with exit
// code 0 and nothing on either stream -- the silence was the whole defect (WI 11550391).
test("the monitor started through a symlinked plugin directory actually runs", async (t) => {
  const root = scratch();
  mkdirSync(join(root, "plugins"), { recursive: true });
  const pluginLink = join(root, "plugins", "kwos-session-bus");
  try {
    linkDir(pluginDir, pluginLink);
  } catch (err) {
    t.skip(`this machine allows no directory link without privileges: ${err.code}`);
    return;
  }

  // A marker in the working directory, so the monitor resolves its session id at once instead of
  // polling for it; a relay that refuses the connection immediately, so registration fails fast and
  // lands on stderr -- the process must live on regardless.
  const cwd = join(root, "work");
  mkdirSync(join(cwd, ".kwos-session-bus"), { recursive: true });
  writeFileSync(join(cwd, ".kwos-session-bus", "client-under-test"), "session-under-test\n", "utf8");

  const child = spawn(process.execPath, [join(pluginLink, "server", "listen.js")], {
    cwd,
    env: {
      ...process.env,
      KWOS_CLIENT_ID: "client-under-test",
      KWOS_RELAY_URL: "http://127.0.0.1:1",
      KWOS_XID_ACCESS_TOKEN: "test-token",
      CLAUDE_CODE_SESSION_ID: "session-under-test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let out = "";
  let err = "";
  let exited = null;
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  const gone = new Promise((resolve) => child.on("exit", (code, signal) => {
    exited = { code, signal };
    resolve();
  }));

  // One hook, in order: the child has to be gone before its scratch directory is removed, and a
  // running child would keep the test runner's event loop alive (a second after-hook cannot order
  // that reliably). rmSync removes a junction itself and leaves its target alone (measured).
  t.after(async () => {
    if (exited === null) {
      child.kill();
      await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  await new Promise((resolve) => setTimeout(resolve, 2500));

  assert.equal(
    exited,
    null,
    `the monitor returned instead of running: ${JSON.stringify(exited)}; ` +
      `stdout=${JSON.stringify(out)} stderr=${JSON.stringify(err)}`
  );
});
