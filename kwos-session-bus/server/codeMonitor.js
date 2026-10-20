// kwcollab code exchange (WI 11517979) -- the monitor's part: serve this worktree's snapshots for
// as long as it is in code mode, and know whether an incoming code line may wake the agent.
//
// The monitor process lives as long as the session, which makes it the one place that can hold the
// back channel open (the MCP server answers tool calls, the hooks run per event). Everything here is
// skipped where the worktree has not joined code mode -- a local file test, no network.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { config } from "./config.js";
import { getAccessToken } from "./auth.js";
import { log } from "./log.js";
import { runSseReceiver } from "./sse-receiver.js";
import { startServing, relayAdapter } from "./codeServe.js";

function localState(cwd) {
  const r = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return null;
  const file = join(r.stdout.trim(), "kwcollab", "state.json");
  if (!existsSync(file)) return null;
  try { return { ...JSON.parse(readFileSync(file, "utf8")), top: spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", windowsHide: true }).stdout.trim() }; }
  catch { return null; }
}

/**
 * The hook the channel listener calls per poll and per opened stream:
 *   refresh(collabId, entry)  -- start serving if this worktree is in code mode for that collab,
 *                                and set entry.wake from the own mandate
 *   drop(collabId)            -- the channel is gone for this session: stop serving it
 */
export function codeServing({ cwd }) {
  const serving = new Map();   // collabId -> AbortController
  const relay = relayAdapter({ relayUrl: config.relayUrl, getToken: getAccessToken });

  async function refresh(collabId, entry) {
    const st = localState(cwd);
    if (!st || st.collab !== collabId) { drop(collabId); return; }
    try {
      const code = await relay.get(`/v1/collabs/${encodeURIComponent(collabId)}/code`);
      const mine = (code.members || []).find((m) => m.subject === st.me);
      entry.wake = mine?.mandate?.wake !== false;
    } catch (err) {
      log.error("Code-Status nicht abrufbar.", { collabId, error: String(err) });
    }
    if (serving.has(collabId)) return;
    const controller = new AbortController();
    serving.set(collabId, controller);
    log.info("Code-Austausch: stelle Stände bereit.", { collabId });
    startServing({
      relayUrl: config.relayUrl, getToken: getAccessToken, collabId, top: st.top, signal: controller.signal,
      runSse: (onMessage, opts) => runSseReceiver(onMessage, opts),
      onError: (e) => log.error("Bereitstellen fehlgeschlagen.", { collabId, error: String(e) }),
    }).catch((err) => {
      if (!controller.signal.aborted) log.error("Bereitstellen beendet.", { collabId, error: String(err) });
    });
  }

  function drop(collabId) {
    const c = serving.get(collabId);
    if (c) { c.abort(); serving.delete(collabId); }
  }

  return { refresh, drop };
}
