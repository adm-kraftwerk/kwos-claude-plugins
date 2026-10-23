// server/is-main.js -- the one place that decides whether a module is the process entry point.
//
// The comparison has to run on RESOLVED paths. `import.meta.url` always carries the real path,
// while `process.argv[1]` carries the path the caller named. In a fleet install where
// `~/.claude/plugins` is a symlink -- measured on a real machine, not a hypothesis -- the two
// differ, a raw string comparison quietly answers "not main", and every entry point exits 0 with
// an empty stdout AND stderr: no tool, no log line, just a closed channel (WI 11550391). The same
// shape killed the process on an unreadable working directory before its first line (WI 11523603).
//
// A guard that does nothing on mismatch hides its own failure better than no guard at all, so the
// mismatch must stay a real decision: only the file that was actually started starts.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The resolved form of a path, for comparing two spellings of the same file.
 *
 * A path that does not exist cannot be resolved; then the raw value is the honest answer. Throwing
 * here would turn a running entry point into a silent exit, which is the failure this file exists
 * to prevent.
 */
function realPath(p, resolve) {
  try {
    return resolve(p);
  } catch {
    return p;
  }
}

/**
 * True when `argv[1]` names the module that lives at `moduleUrl`.
 *
 * The caller passes ITS OWN `import.meta.url` -- it cannot be defaulted here: `import.meta.url`
 * inside this function names THIS file, so a guard written as `isMainModule()` would compare the
 * guard's own path with argv[1], answer false for every entry point, and hide its mistake exactly
 * the way the string comparison did. Hence: no default, and an omission throws (pinned in
 * `tests/is-main.test.js`) instead of answering a quiet false.
 *
 * `argv` and `resolve` are injectable for tests; production uses the defaults. The default
 * `resolve` is `realpathSync.native`, which also normalises the on-disk letter case on Windows and
 * follows junctions.
 */
export function isMainModule(
  moduleUrl,
  { argv = process.argv, resolve = realpathSync.native } = {}
) {
  if (!argv || !argv[1]) return false;
  // Both sides point at the same physical file, so both resolve to the same string -- that is the
  // whole fix: a symlink in the path cannot make an entry point look like an import.
  return realPath(fileURLToPath(moduleUrl), resolve) === realPath(argv[1], resolve);
}
