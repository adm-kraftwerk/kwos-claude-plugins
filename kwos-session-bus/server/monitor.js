#!/usr/bin/env node
// The ONE monitor process a session with this plugin gets (monitors/monitors.json).
//
// WHY THERE IS EXACTLY ONE (2026-10-19, WI 11506447): a monitor entry in the plugin manifest is a
// promise the harness makes to the session -- Claude Code starts it at session start (a missing
// `when` and `"always"` mean the same thing) and ANNOUNCES it by its description before the
// process can say anything. A second entry for the kwcollab channel therefore reached every
// `--kwremote` session of the fleet -- this plugin is enabled there for Remote Control, a released
// feature -- with a description naming an unreleased feature and its workitem, and the monitor
// exited a moment later. The gate inside the process was correct and still too late.
//
// So the receive paths are composed HERE, and the manifest names only the relay:
//   - the relay path (server/listen.js) always runs -- it is what `--kwremote` is for;
//   - the channel path (server/collab-listen.js) runs only where the ring released it, and
//     `startCollabListener` returns `null` otherwise (no poll, no stream, no line, nothing
//     announced).
// One stdout, one line writer: the 250 ms spacing between lines is what keeps a burst from being
// bundled into one truncated notification (s. listen.js), so it has to be one writer, not two.
//
// Diagnostics go to stderr, lines for the session to stdout -- the convention of this plugin.

import { createLineWriter } from "./listen.js";
import { startRelayListener } from "./listen.js";
import { startCollabListener } from "./collab-listen.js";
import { log } from "./log.js";

async function main() {
  const writeLine = createLineWriter(process.stdout);

  const relay = await startRelayListener({ writeLine });
  // `null` outside the ring, s. the header -- and that is the whole point: what must not be seen
  // stays unannounced.
  const collab = await startCollabListener({ writeLine });

  try {
    // The relay path decides the process's life: it exists in every session, the channel path only
    // next to it. Both paths register their own SIGINT/SIGTERM handlers.
    await relay.ended;
  } finally {
    if (collab) {
      collab.stop();
      await collab.ended;
    }
    // Beim Session-Ende noch gepufferte Zeilen ausliefern, statt sie mit dem Prozess zu verlieren.
    await writeLine.flush();
  }
}

main().catch((err) => {
  log.error("Unerwarteter Fehler im Session-Bus-Monitor.", { error: String(err) });
  process.exit(1);
});
