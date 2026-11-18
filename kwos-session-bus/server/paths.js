// server/paths.js -- the one place that knows the same path is SPELLED differently on Windows,
// macOS and Linux.
//
// Three shapes keep costing a red suite in a PR that touched neither (measured 2026-11-18 on the
// Windows specimen, PRs #57 and #58):
//
//   1. SEPARATORS. `C:\x\y` and `C:/x/y` name one file; a string comparison says they do not.
//   2. SPELLINGS. `~/.claude/plugins` is a link -- `import.meta.url` carries the real path,
//      `process.argv[1]` the name the caller used (WI 11550391).
//   3. BUILD PATHS. esbuild writes the module path it saw into the bundle, as a comment and as the
//      module key. Built on a Mac from a linked checkout, those read
//      `../../../../Users/steffenforkmann/src/.../node_modules/ajv/...`; built on Windows from the
//      package root they read `node_modules/ajv/...`. Same code, different bytes -- so a
//      byte-exact "is the committed bundle current?" gate is green only on the machine that built
//      it, and every other machine reports a stale bundle that is not stale.
//
// The callers use these on BOTH sides of a comparison, never on one: normalising a single side
// would hide a real difference instead of a spelling.

import { realpathSync } from "node:fs";

/**
 * The resolved form of a path, for comparing two spellings of the same file.
 *
 * A path that does not exist cannot be resolved; then the raw value is the honest answer. Throwing
 * here would turn a running entry point into a silent exit -- the failure `is-main.js` exists to
 * prevent. The default resolves case and links the way the platform does (`realpathSync.native`
 * normalises the drive-letter case on Windows and follows junctions).
 */
export function realPath(p, resolve = realpathSync.native) {
  try {
    return resolve(p);
  } catch {
    return p;
  }
}

/** True when two spellings name the same file on disk. */
export function samePath(a, b, resolve = realpathSync.native) {
  if (typeof a !== "string" || typeof b !== "string" || a === "" || b === "") return false;
  return realPath(a, resolve) === realPath(b, resolve);
}

/** One separator for every platform -- for comparisons and for text that leaves the machine. */
export function toPosix(p) {
  return String(p).replace(/\\/g, "/");
}

/**
 * A bundle text with esbuild's build-machine paths folded back to `node_modules/`.
 *
 * Only the two places esbuild writes a module path are touched: the `// <path>` comment above a
 * module and the `"<path>"` key that wraps it. Anything else -- the code itself -- stays byte for
 * byte, so a forgotten `npm run build` is still a difference and still fails the gate.
 */
export function normalizeBuildPaths(text) {
  return String(text)
    .replace(/^(\/\/ ).*?\/?node_modules\//gm, "$1node_modules/")
    .replace(/"([^"\n]*?)node_modules\//g, '"node_modules/');
}
