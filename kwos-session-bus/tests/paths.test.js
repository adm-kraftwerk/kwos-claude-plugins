import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeBuildPaths, samePath, toPosix } from "../server/paths.js";

test("toPosix: ein Windows-Pfad und seine POSIX-Schreibweise sind EIN Text", () => {
  assert.equal(toPosix("C:\\x\\y\\z.js"), "C:/x/y/z.js");
  assert.equal(toPosix("/x/y/z.js"), "/x/y/z.js");
  assert.equal(toPosix("C:\\x\\y\\z.js"), toPosix("C:/x/y/z.js"));
});

test("samePath: dieselbe Datei unter zwei Schreibweisen, ein Link dazwischen", (t) => {
  const root = mkdtempSync(join(tmpdir(), "kwos-paths-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const real = join(root, "real");
  mkdirSync(real);
  const file = join(real, "entry.mjs");
  writeFileSync(file, "", "utf8");

  assert.equal(samePath(file, file), true);

  // Windows braucht fuer ein Verzeichnis-Link einen Junction (Symlink verlangt Developer Mode oder
  // Admin), POSIX nimmt "dir" -- wie in tests/is-main.test.js.
  const link = join(root, "link");
  try {
    symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
  } catch (err) {
    t.skip(`diese Maschine erlaubt keinen Verzeichnis-Link ohne Rechte: ${err.code}`);
    return;
  }
  assert.equal(samePath(join(link, "entry.mjs"), file), true, "derselbe physische Pfad");
});

test("samePath: zwei verschiedene Dateien sind NICHT gleich, und Fehlendes wirft nicht", () => {
  const root = mkdtempSync(join(tmpdir(), "kwos-paths-"));
  try {
    writeFileSync(join(root, "a.js"), "", "utf8");
    writeFileSync(join(root, "b.js"), "", "utf8");
    assert.equal(samePath(join(root, "a.js"), join(root, "b.js")), false);
    assert.equal(samePath(join(root, "gone.js"), join(root, "a.js")), false);
    assert.equal(samePath("", join(root, "a.js")), false);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("normalizeBuildPaths: Mac- und Windows-Build falten auf denselben Text", () => {
  // Die Formen sind gemessen (2026-11-18): so schrieb esbuild den Modulpfad auf dem Mac des
  // verlinkten Checkouts und auf dem Windows-Specimen.
  const mac = [
    "// ../../../../Users/steffenforkmann/src/kwos-claude-plugins/kwos-session-bus/node_modules/ajv/dist/util.js",
    '  "../../../../Users/steffenforkmann/src/kwos-claude-plugins/kwos-session-bus/node_modules/ajv/dist/util.js"(exports) {',
  ].join("\n");
  const win = [
    "// node_modules/ajv/dist/util.js",
    '  "node_modules/ajv/dist/util.js"(exports) {',
  ].join("\n");
  assert.equal(normalizeBuildPaths(mac), normalizeBuildPaths(win));
});

test("normalizeBuildPaths: der CODE bleibt Byte fuer Byte -- ein vergessenes Build bleibt rot", () => {
  const current = 'const SOURCES_TOOLS = [];\nconsole.log("FREIGABE");\n';
  const stale = 'const SOURCES_TOOLS = [];\n';
  assert.notEqual(normalizeBuildPaths(current), normalizeBuildPaths(stale));
  // Ein Text, der zufaellig das Wort enthaelt, wird nicht veraendert, wenn kein Pfad davor steht.
  assert.equal(normalizeBuildPaths('const p = "node_modules/x";\n'), 'const p = "node_modules/x";\n');
});

