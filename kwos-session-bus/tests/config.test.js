import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findMarker } from "../server/config.js";

const CONFIG_URL = new URL("../server/config.js", import.meta.url).href;
const CLIENT_ID = "cli-1234-abcd1234";

function scratch() {
  return mkdtempSync(join(tmpdir(), "kwos-session-bus-"));
}

test("findMarker walks up from the starting directory", () => {
  const root = scratch();
  const deep = join(root, "a", "b");
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(root, ".kwos-session-bus-id"), "sess-up\n", "utf8");

  assert.deepEqual(findMarker(deep, ".kwos-session-bus-id"), { path: join(root, ".kwos-session-bus-id"), id: "sess-up" });
  assert.equal(findMarker(deep, ".kwos-session-bus/absent"), null);
});

test("findMarker: an empty marker is not an answer", () => {
  const root = scratch();
  writeFileSync(join(root, ".kwos-session-bus-id"), "   \n", "utf8");
  assert.equal(findMarker(root, ".kwos-session-bus-id"), null);
});

// The actual complaint: after `/clear` (or `--resume`) Claude Code hands out a new session id
// inside the running process. The relay hooks see the new id and the PWA lists the session under
// it, while the already-running listener keeps the old one -- so a message sent from the phone is
// delivered to nobody. The fix is that the reader re-reads its marker and re-binds.
//
// Runs in a child process on purpose: config.js resolves the marker against its own cwd and env,
// which a test cannot change for an already-imported module.
test("refreshSessionId adopts the id a rewritten marker carries, and stays put otherwise", () => {
  const dir = scratch();
  const markerDir = join(dir, ".kwos-session-bus");
  mkdirSync(markerDir, { recursive: true });
  const marker = join(markerDir, CLIENT_ID);
  writeFileSync(marker, "session-ONE", "utf8");

  const script = `
    import { writeFileSync } from "node:fs";
    import { config, ensureSessionId, refreshSessionId } from ${JSON.stringify(CONFIG_URL)};
    await ensureSessionId();
    const before = config.sessionId;
    const unchanged = await refreshSessionId();
    writeFileSync(${JSON.stringify(marker)}, "session-TWO", "utf8");   // the SessionStart hook after /clear
    const rebound = await refreshSessionId();
    const stable = await refreshSessionId();                           // a second look changes nothing
    console.log(JSON.stringify({ before, unchanged, rebound, stable, after: config.sessionId }));
  `;

  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: dir,
    // The env value is deliberately STALE: that is exactly the situation after /clear. The marker
    // must win over it, otherwise the fix would not fix anything.
    env: { ...process.env, KWOS_CLIENT_ID: CLIENT_ID, CLAUDE_CODE_SESSION_ID: "session-STALE-ENV" },
    encoding: "utf8",
  });
  const r = JSON.parse(out.trim().split("\n").pop());

  assert.equal(r.before, "session-ONE");
  assert.equal(r.unchanged, false, "an unchanged marker must not trigger a re-bind");
  assert.equal(r.rebound, true, "/clear must trigger a re-bind");
  assert.equal(r.stable, false, "the re-bind happens once, not on every tick");
  assert.equal(r.after, "session-TWO");
});

test("without its own marker nothing changes -- no session is lost to a missing hook", () => {
  const dir = scratch();
  const script = `
    import { config, ensureSessionId, refreshSessionId, sessionIdMarkerPath } from ${JSON.stringify(CONFIG_URL)};
    await ensureSessionId();
    const changed = await refreshSessionId();
    console.log(JSON.stringify({ changed, after: config.sessionId, path: sessionIdMarkerPath() }));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: dir,
    env: { ...process.env, KWOS_CLIENT_ID: CLIENT_ID, CLAUDE_CODE_SESSION_ID: "session-FROM-ENV" },
    encoding: "utf8",
  });
  const r = JSON.parse(out.trim().split("\n").pop());

  assert.equal(r.after, "session-FROM-ENV", "the env value is still the fallback when no hook wrote a marker");
  assert.equal(r.changed, false);
  assert.equal(r.path, null);
});
