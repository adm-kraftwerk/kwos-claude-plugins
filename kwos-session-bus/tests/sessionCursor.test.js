import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SESSION_CURSOR_FILE,
  readSessionCursor,
  rememberSessionCursor,
  sessionCursorsPath,
} from "../server/sessionCursor.js";

// WHERE THIS SESSION LEFT OFF, ON DISK (measured 2026-10-29). The relay has always sent `id:` on
// every frame; this note is what turns a NEW process into a resume instead of a fresh, cursorless
// connect that only gets what is still undelivered -- so a message written to the socket but never
// printed was lost for good.

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "kwos-cursor-"));
  try {
    return fn(join(dir, SESSION_CURSOR_FILE), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the path defaults to the kraftwerk config dir and honours both overrides", () => {
  assert.equal(sessionCursorsPath({ HOME: "/home/x" }), "/home/x/.config/kraftwerk/" + SESSION_CURSOR_FILE);
  assert.equal(sessionCursorsPath({ HOME: "/home/x", KWOS_CLAUDE_CFG: "/cfg" }), "/cfg/" + SESSION_CURSOR_FILE);
  assert.equal(sessionCursorsPath({ HOME: "/home/x", KWOS_RELAY_CURSORS: "/tmp/c.json" }), "/tmp/c.json");
});

test("nothing seen yet is null, not zero", withDir((path) => {
  assert.equal(readSessionCursor("s1", path), null);
  // A cursor of 0 would mean "from the beginning" and replay the whole protocol.
  rememberSessionCursor("s1", 0, path);
  assert.equal(readSessionCursor("s1", path), null);
  rememberSessionCursor("s1", Number.NaN, path);
  assert.equal(readSessionCursor("s1", path), null);
}));

test("it survives a process: written here, read there", withDir((path) => {
  rememberSessionCursor("s1", 42, path);
  assert.equal(readSessionCursor("s1", path), 42);
  // And a SECOND read of the same file (a new process) sees it too.
  assert.equal(readSessionCursor("s1", path), 42);
}));

test("it never goes backwards -- a late frame must not make the relay repeat itself", withDir((path) => {
  rememberSessionCursor("s1", 42, path);
  rememberSessionCursor("s1", 7, path);
  assert.equal(readSessionCursor("s1", path), 42);
  rememberSessionCursor("s1", 43, path);
  assert.equal(readSessionCursor("s1", path), 43);
}));

test("every session has its own place -- /clear and --resume are new streams", withDir((path) => {
  rememberSessionCursor("s1", 42, path);
  rememberSessionCursor("s2", 3, path);
  assert.equal(readSessionCursor("s1", path), 42);
  assert.equal(readSessionCursor("s2", path), 3);
  // A session the file never saw starts at the beginning, not at another session's place.
  assert.equal(readSessionCursor("s3", path), null);
}));

test("an unreadable or foreign file is empty, never a crash", withDir((path) => {
  writeFileSync(path, "kein json");
  assert.equal(readSessionCursor("s1", path), null);
  writeFileSync(path, "[1,2,3]");
  assert.equal(readSessionCursor("s1", path), null);
  writeFileSync(path, '{"s1":"zwei","s2":-1}');
  assert.equal(readSessionCursor("s1", path), null);
  assert.equal(readSessionCursor("s2", path), null);
  // Writing on top of it repairs the file instead of failing.
  rememberSessionCursor("s1", 5, path);
  assert.equal(readSessionCursor("s1", path), 5);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).s1, 5);
}));

test("the file stays bounded -- the oldest sessions go first", withDir((path) => {
  for (let i = 1; i <= 205; i += 1) rememberSessionCursor(`s${i}`, i, path);
  const all = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(Object.keys(all).length <= 200, `expected at most 200 entries, got ${Object.keys(all).length}`);
  // The newest are still there, the very oldest is gone.
  assert.equal(readSessionCursor("s205", path), 205);
  assert.equal(readSessionCursor("s1", path), null);
}));
