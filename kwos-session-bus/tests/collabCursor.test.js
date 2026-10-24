import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCursor, rememberCursor } from "../server/collabCursor.js";

// The read cursor survives a PROCESS on purpose: a closed and reopened session starts a new plugin
// process, and without the note on disk it asked the relay for the whole protocol again (field
// report 2026-10-19: "wenn man session schließt und öffnet dann wird ne alte collab message nochmal
// abgespielt"). Since WI 11551159 it is kept PER SESSION: two sessions of one person on the same box
// read the same channel at their own pace.

const dir = mkdtempSync(join(tmpdir(), "kwcollab-cursor-"));
const path = join(dir, "cursors.json");

test("ein unbekannter Kanal hat keinen Stand -- und die Datei darf fehlen", () => {
  assert.equal(readCursor("c-1", "s-1", path), null);
});

test("was gemerkt wurde, ist nach einem neuen Prozess noch da", () => {
  rememberCursor("c-1", 7, "s-1", path);
  assert.equal(readCursor("c-1", "s-1", path), 7);
  assert.equal(JSON.parse(readFileSync(path, "utf8"))["s-1|c-1"], 7);
});

test("der Stand geht nicht zurueck", () => {
  rememberCursor("c-1", 5, "s-1", path);
  assert.equal(readCursor("c-1", "s-1", path), 7);
});

test("zwei Sitzungen lesen denselben Kanal unabhaengig", () => {
  const two = join(dir, "two.json");
  rememberCursor("c-1", 7, "s-1", two);
  assert.equal(readCursor("c-1", "s-2", two), null, "die zweite Sitzung faengt bei ihrem Beitritt an");
  rememberCursor("c-1", 3, "s-2", two);
  assert.equal(readCursor("c-1", "s-1", two), 7);
  assert.equal(readCursor("c-1", "s-2", two), 3);
});

test("migration: an old channel-only cursor counts once for the session -- no backlog replay", () => {
  // Before cursors were kept per session, the file had one key per channel. After the update the
  // session key is missing; without the fallback every session would start at zero and replay the
  // whole backlog once -- exactly what this store exists to prevent.
  const old = join(dir, "migration.json");
  writeFileSync(old, JSON.stringify({ "c-1": 17 }));
  assert.equal(readCursor("c-1", "s-new", old), 17);
  rememberCursor("c-1", 23, "s-new", old);
  assert.equal(readCursor("c-1", "s-new", old), 23);
  // A different session starts at the old channel stand as well -- it never read the channel.
  assert.equal(readCursor("c-1", "s-second", old), 17);
  // And the session key wins once it exists, even when the old one is higher.
  writeFileSync(old, JSON.stringify({ "c-1": 99, "s-new|c-1": 23 }));
  assert.equal(readCursor("c-1", "s-new", old), 23);
});

test("unlesbare Werte werden nicht uebernommen", () => {
  rememberCursor("c-2", 0, "s-1", path);
  rememberCursor("c-2", Number.NaN, "s-1", path);
  assert.equal(readCursor("c-2", "s-1", path), null);
});

test("eine kaputte Datei heisst 'nichts gemerkt', nicht Absturz", () => {
  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{ kein json");
  assert.equal(readCursor("c-1", "s-1", broken), null);
  rememberCursor("c-1", 3, "s-1", broken);
  assert.equal(readCursor("c-1", "s-1", broken), 3);
});

test("die Datei bleibt begrenzt -- alte Kanaele fallen raus", () => {
  const many = join(dir, "many.json");
  for (let i = 1; i <= 45; i += 1) rememberCursor(`c-${i}`, i, "s-1", many);
  const all = JSON.parse(readFileSync(many, "utf8"));
  assert.ok(Object.keys(all).length <= 40, `zu viele Eintraege: ${Object.keys(all).length}`);
  // Die juengsten sind noch da.
  assert.equal(readCursor("c-45", "s-1", many), 45);
});
