import { config } from "./config.js";
import { getAccessToken } from "./auth.js";

/**
 * @typedef {Object} SessionInfo
 * @property {string} session_id
 * @property {string} display_name
 * @property {string} [team]
 * @property {string} last_heartbeat
 */

/**
 * @typedef {Object} RelayMessage
 * @property {string} message_id
 * @property {string} from_session
 * @property {string} to_session
 * @property {string} text
 * @property {string} created_at
 * @property {string|null} delivered_at
 * @property {string} [workitem_ref]
 */

async function call(path, { method = "GET", body, headers } = {}) {
  if (!config.relayUrl) {
    throw new Error("KWOS_RELAY_URL ist nicht gesetzt.");
  }
  const token = await getAccessToken();
  const res = await fetch(`${config.relayUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok && res.status !== 202) {
    const text = await res.text().catch(() => "");
    throw new Error(`Relay ${method} ${path} -> ${res.status}: ${text}`);
  }

  const queued = res.status === 202;
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, queued, data };
}

/** POST /v1/sessions/register — bei Session-Start, nicht als Tool exponiert. */
export function register() {
  return call("/v1/sessions/register", {
    method: "POST",
    body: { session_id: config.sessionId, display_name: config.displayName },
  });
}

/** POST /v1/sessions/{self}/heartbeat — periodisch, nicht als Tool exponiert. */
export function heartbeat() {
  return call(`/v1/sessions/${encodeURIComponent(config.sessionId)}/heartbeat`, {
    method: "POST",
  });
}

/** GET /v1/sessions — Tool list_sessions. */
export async function listSessions() {
  const { data } = await call("/v1/sessions");
  return /** @type {SessionInfo[]} */ (data ?? []);
}

/**
 * POST /v1/sessions/{target}/messages — Tool send_message.
 * 201 = Zielsession online, 202 = queued (Zielsession offline/unbekannt).
 */
export async function sendMessage(target, text, workitemRef) {
  const { status, queued } = await call(`/v1/sessions/${encodeURIComponent(target)}/messages`, {
    method: "POST",
    body: { from: config.sessionId, text, workitem_ref: workitemRef },
  });
  return { delivered: status === 201, queued };
}

/** POST /v1/sessions/broadcast — Tool broadcast. */
export async function broadcast(text, workitemRef) {
  await call("/v1/sessions/broadcast", {
    method: "POST",
    body: { from: config.sessionId, text, workitem_ref: workitemRef },
  });
}

/** URL für den SSE-Empfang, GET /v1/sessions/{self}/events. */
export function eventsUrl() {
  return `${config.relayUrl}/v1/sessions/${encodeURIComponent(config.sessionId)}/events`;
}
