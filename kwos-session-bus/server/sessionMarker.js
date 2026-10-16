// The spelling of the session-id marker, in ONE place: the SessionStart hook writes it
// (hooks/write-session-id.js) and the MCP server and the monitor read it (server/config.js).
// A hook and a reader that disagree about the name fail silently -- the reader finds nothing and
// falls back to a random id, which is exactly the failure this marker exists to prevent.
//
// Pure, no I/O: node --test can exercise it without a project directory (s. tests/sessionMarker.test.js).

export const MARKER_DIR = ".kwos-session-bus";
export const LEGACY_MARKER_FILE = ".kwos-session-bus-id";

// Same character class the launcher guarantees for the client id (litellm repo, WI 11167098:
// `[A-Za-z0-9._:-]{1,128}`). Anything else is never used as a file name -- an unverified string
// must not become a path component.
const CLIENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * File name for one client's marker, or null when there is nothing trustworthy to key on.
 * Null is the normal case outside `--kwremote`: only that launcher exports KWOS_CLIENT_ID, and
 * only under `--kwremote` is this plugin even enabled.
 */
export function clientMarkerName(raw) {
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!CLIENT_ID_RE.test(id)) return null;
  // ':' is legal in the id but not on Windows; one stable, portable spelling for the file name.
  return id.replace(/:/g, "_");
}
