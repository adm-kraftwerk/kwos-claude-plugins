import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.js reads its environment ONCE, at import -- so the paths are set before the dynamic
// import (same pattern as relay-client.test.js). The helper path deliberately does NOT exist:
// every test that passes therefore proves the cache answered and no subprocess was spawned.
//
// ORDER MATTERS: the two MISS cases run first. After the first successful call the module holds a
// last-known token (its fallback for a failed helper), and a later miss would answer with that
// instead of failing -- the test would then prove nothing.
const dir = mkdtempSync(join(tmpdir(), "kwos-auth-"));
const cache = join(dir, "xiam-access");
process.env.KWOS_XID_ACCESS_CACHE = cache;
process.env.KWOS_XID_TOKEN_HELPER_PATH = join(dir, "xiam-token.sh");
delete process.env.KWOS_XID_ACCESS_TOKEN;

const { getAccessToken } = await import("../server/auth.js");

const now = Math.floor(Date.now() / 1000);

test("a STALE cache entry is a miss: the helper decides (and its absence is the failure)", async () => {
  writeFileSync(cache, `${now - 60}\nold-token\n`);
  await assert.rejects(() => getAccessToken(), /Helper nicht gefunden/);
});

test("the margin holds: an entry that dies within the minute is a miss", async () => {
  writeFileSync(cache, `${now + 30}\nalmost-expired\n`);
  await assert.rejects(() => getAccessToken(), /Helper nicht gefunden/);
});

test("a fresh entry in the helper's cache is used WITHOUT spawning the helper", async () => {
  writeFileSync(cache, `${now + 3600}\ncached-token\n`);
  assert.equal(await getAccessToken(), "cached-token");
});

test("a BOM and CRLF (the PowerShell twin's old shapes) do not hide the entry", async () => {
  writeFileSync(cache, `﻿${now + 3600}\r\nbom-token\r\n`);
  assert.equal(await getAccessToken(), "bom-token");
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
