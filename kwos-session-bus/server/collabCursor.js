import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * How far each channel was read, kept across processes (WI 11482928, field report 2026-10-19: "wenn
 * man session schließt und öffnet dann wird ne alte collab message nochmal abgespielt").
 *
 * The SSE receiver tracks `Last-Event-ID` in memory, so a RECONNECT inside one process resumes. A
 * closed and reopened session starts a new process, and without a note on disk it asks the relay for
 * the whole protocol again -- every old line lands in the session a second time.
 *
 * The file is small, per machine and per channel, and bounded: the channels of one machine's sessions
 * are a handful. It is NOT the channel's record -- the relay owns that -- only "how far did this
 * machine read".
 */
export const CURSOR_FILE = "collab-cursors.json";
const MAX_CHANNELS = 40;

export function cursorsPath(env = process.env) {
  const override = typeof env.KWOS_COLLAB_CURSORS === "string" ? env.KWOS_COLLAB_CURSORS.trim() : "";
  if (override !== "") return override;
  const cfg = typeof env.KWOS_CLAUDE_CFG === "string" ? env.KWOS_CLAUDE_CFG.trim() : "";
  const base = cfg !== "" ? cfg : join(env.HOME || homedir(), ".config", "kraftwerk");
  return join(base, CURSOR_FILE);
}

/** The last seq this machine printed for that channel, or null when it never saw one. */
export function readCursor(collabId, path = cursorsPath()) {
  const all = readAll(path);
  const seq = Number(all[collabId]);
  return Number.isFinite(seq) && seq > 0 ? seq : null;
}

/**
 * Remember how far this machine read. Written on every frame with an id: the file is a few dozen
 * bytes, and losing it costs a replay of the whole protocol in the next session.
 */
export function rememberCursor(collabId, seq, path = cursorsPath()) {
  const n = Number(seq);
  if (!Number.isFinite(n) || n <= 0) return;
  const all = readAll(path);
  if (Number(all[collabId]) >= n) return;
  all[collabId] = n;
  // Bounded: the oldest channels go first (a Map keeps insertion order).
  const keys = Object.keys(all);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_CHANNELS))) delete all[key];
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
    renameSync(tmp, path);
  } catch {
    /* best effort: an unwritable store only costs a replay */
  }
}

function readAll(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out = {};
    for (const [key, value] of Object.entries(parsed)) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) out[key] = n;
    }
    return out;
  } catch {
    return {};
  }
}
