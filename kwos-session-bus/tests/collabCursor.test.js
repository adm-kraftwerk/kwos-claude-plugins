import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCursor, rememberCursor } from "../server/collabCursor.js";

// The read cursor survives a PROCESS on purpose: a closed and reopened session starts a new plugin
// process, and without the note on disk it asked the relay for the whole protocol again (field
// report 2026-10-19: "wenn man session schließt und öffnet dann wird ne alte collab message nochmal
// abgespielt").

const dir = mkdtempSync(join(tmpdir(), "kwcollab-cursor-"));
const path = join(dir, "cursors.json");

test("ein unbekannter Kanal hat keinen Stand -- und die Datei darf fehlen", () => {
  assert.equal(readCursor("c-1", path), null);
});

test("was gemerkt wurde, ist nach einem neuen Prozess noch da", () => {
  rememberCursor("c-1", 7, path);
  assert.equal(readCursor("c-1", path), 7);
  assert.equal(JSON.parse(readFileSync(path, "utf8"))["c-1"], 7);
});

test("der Stand geht nicht zurueck", () => {
  rememberCursor("c-1", 5, path);
  assert.equal(readCursor("c-1", path), 7);
});

test("unlesbare Werte werden nicht uebernommen", () => {
  rememberCursor("c-2", 0, path);
  rememberCursor("c-2", Number.NaN, path);
  assert.equal(readCursor("c-2", path), null);
});

test("eine kaputte Datei heisst 'nichts gemerkt', nicht Absturz", () => {
  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{ kein json");
  assert.equal(readCursor("c-1", broken), null);
  rememberCursor("c-1", 3, broken);
  assert.equal(readCursor("c-1", broken), 3);
});

test("die Datei bleibt begrenzt -- alte Kanaele fallen raus", () => {
  const many = join(dir, "many.json");
  for (let i = 1; i <= 45; i += 1) rememberCursor(`c-${i}`, i, many);
  const all = JSON.parse(readFileSync(many, "utf8"));
  assert.ok(Object.keys(all).length <= 40, `zu viele Eintraege: ${Object.keys(all).length}`);
  // Die juengsten sind noch da.
  assert.equal(readCursor("c-45", many), 45);
});
