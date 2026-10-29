import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * How far THIS session read its own stream, kept across processes.
 *
 * WHY A FILE AND NOT `lastEventId` ALONE (measured 2026-10-29). The SSE receiver keeps the id in
 * memory, so a RECONNECT inside one process resumes exactly. A closed and reopened session -- a
 * crash, a laptop that slept, `--resume` -- starts a NEW process with no id, and the relay answers
 * a cursorless connect with only what is still undelivered. A message whose frame had been written
 * to the socket but not yet printed was marked delivered and never came again: on the phone it read
 * as sent, in the session it never arrived.
 *
 * The relay has carried `id:` on every frame all along (relay/sessionEventsRoute.js) and resumes
 * from `Last-Event-ID`/`?since=`; nothing was missing but the note on disk. The channel path has
 * had exactly this file since WI 11482928 (`collabCursor.js`) for the same reason, in the other
 * direction.
 *
 * Keyed by the session id: `/clear` and `--resume` give the process a new one, and that is a new
 * stream with its own place -- an old cursor must not swallow what the new session should see.
 */
export const SESSION_CURSOR_FILE = "relay-cursors.json";
const MAX_SESSIONS = 200;

export function sessionCursorsPath(env = process.env) {
  const override = typeof env.KWOS_RELAY_CURSORS === "string" ? env.KWOS_RELAY_CURSORS.trim() : "";
  if (override !== "") return override;
  const cfg = typeof env.KWOS_CLAUDE_CFG === "string" ? env.KWOS_CLAUDE_CFG.trim() : "";
  const base = cfg !== "" ? cfg : join(env.HOME || homedir(), ".config", "kraftwerk");
  return join(base, SESSION_CURSOR_FILE);
}

/** The last seq this session received, or `null` when it never saw one. */
export function readSessionCursor(sessionId, path = sessionCursorsPath()) {
  if (typeof sessionId !== "string" || sessionId === "") return null;
  const all = readAll(path);
  const seq = Number(all[sessionId]);
  return Number.isFinite(seq) && seq > 0 ? seq : null;
}

/**
 * Remember how far this session read. Written on every frame that carries an id: the file is a few
 * dozen bytes, and losing it costs a message.
 *
 * NEVER BACKWARDS: a late frame from an old connection must not move the note behind what the
 * session already has -- the relay would then deliver those messages a second time.
 */
export function rememberSessionCursor(sessionId, seq, path = sessionCursorsPath()) {
  if (typeof sessionId !== "string" || sessionId === "") return;
  const n = Number(seq);
  if (!Number.isFinite(n) || n <= 0) return;
  const all = readAll(path);
  if (Number(all[sessionId]) >= n) return;
  all[sessionId] = n;
  // Bounded: the oldest sessions go first (an object keeps insertion order).
  const keys = Object.keys(all);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SESSIONS))) delete all[key];
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
