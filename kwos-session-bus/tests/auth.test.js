import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// config.js reads its environment ONCE, at import -- so the paths are set before the dynamic
// import (same pattern as relay-client.test.js). The helper path deliberately does NOT exist:
// every test that passes therefore proves the cache answered and no subprocess was spawned.
//
// ORDER MATTERS: the two MISS cases run first. After the first successful call the module holds a
// last-known token (its fallback for a failed helper), and a later miss would answer with that
// instead of failing -- the test would then prove nothing.
//
// TWO PATHS on purpose (2026-11-03): on Windows the bash helper writes `~/.config/kraftwerk/`,
// the PowerShell one `%LOCALAPPDATA%\kraftwerk\`. The override takes a delimiter-separated list,
// so both are exercised on every platform.
const dir = mkdtempSync(join(tmpdir(), "kwos-auth-"));
const primary = join(dir, "xiam-access-primary");
const secondary = join(dir, "xiam-access-secondary");
process.env.KWOS_XID_ACCESS_CACHE = [primary, secondary].join(delimiter);
process.env.KWOS_XID_TOKEN_HELPER_PATH = join(dir, "xiam-token.sh");
delete process.env.KWOS_XID_ACCESS_TOKEN;

const { getAccessToken } = await import("../server/auth.js");

const now = Math.floor(Date.now() / 1000);
const rm = (p) => {
  try {
    unlinkSync(p);
  } catch {
    /* not there: exactly what the test wants */
  }
};

test("a STALE cache entry is a miss: the helper decides (and its absence is the failure)", async () => {
  writeFileSync(primary, `${now - 60}\nold-token\n`);
  rm(secondary);
  await assert.rejects(() => getAccessToken(), /Helper nicht gefunden/);
});

test("the margin holds: an entry that dies within the minute is a miss", async () => {
  writeFileSync(primary, `${now + 30}\nalmost-expired\n`);
  rm(secondary);
  await assert.rejects(() => getAccessToken(), /Helper nicht gefunden/);
});

test("a fresh entry in the helper's cache is used WITHOUT spawning the helper", async () => {
  writeFileSync(primary, `${now + 3600}\ncached-token\n`);
  rm(secondary);
  assert.equal(await getAccessToken(), "cached-token");
});

test("a BOM and CRLF (the PowerShell twin's old shapes) do not hide the entry", async () => {
  writeFileSync(primary, `﻿${now + 3600}\r\nbom-token\r\n`);
  rm(secondary);
  assert.equal(await getAccessToken(), "bom-token");
});

test("the SECOND path answers when the first has nothing (Windows: the bash helper's file)", async () => {
  rm(primary);
  writeFileSync(secondary, `${now + 3600}\nsecond-path-token\n`);
  assert.equal(await getAccessToken(), "second-path-token");
});

test("a stale entry in the first path does not hide a fresh one in the second", async () => {
  writeFileSync(primary, `${now - 60}\nold-token\n`);
  writeFileSync(secondary, `${now + 3600}\nfresh-second\n`);
  assert.equal(await getAccessToken(), "fresh-second");
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
