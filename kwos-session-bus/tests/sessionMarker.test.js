import test from "node:test";
import assert from "node:assert/strict";

import { clientMarkerName } from "../server/sessionMarker.js";

// The marker file is the ONLY thing that survives /clear and --resume (the env value is frozen at
// process start), and the hook and the readers must spell its name identically. A hook that writes
// one name while the reader looks for another fails silently: the reader falls back to a random id
// and the session becomes unreachable.
test("clientMarkerName: the launcher's client id becomes a portable file name", () => {
  assert.equal(clientMarkerName("cli-9480-8cb57c3a"), "cli-9480-8cb57c3a");
  // ':' is legal in the id and not on Windows -- one stable spelling on every platform.
  assert.equal(clientMarkerName("cli:1234:abcd"), "cli_1234_abcd");
  assert.equal(clientMarkerName("  cli-1-a  "), "cli-1-a");
});

test("clientMarkerName: anything unverified is refused, never used as a path component", () => {
  for (const bad of ["", "   ", null, undefined, 42, "../../etc/passwd", "cli 1", "cli/1", "a".repeat(129)]) {
    assert.equal(clientMarkerName(bad), null, `${JSON.stringify(bad)} must not become a marker name`);
  }
});
