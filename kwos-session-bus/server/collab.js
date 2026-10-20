// kwcollab -- the shared channel on one workitem (WI 11482928, spec in kw/OS 11482928).
//
// The relay side lives in the litellm repo (relay/server.js, routes under /v1/collabs). This file
// is the client: it talks to those routes with the session's own XID identity, and it answers the
// one question every tool and the monitor start with -- WHICH collab is THIS session in?
//
// That question is answered from the relay, never locally: joining is a fact on the server (the
// member row carries the session id), and a local guess would let a session talk into a channel it
// was removed from.
import { config } from "./config.js";
import { getAccessToken } from "./auth.js";
import { rememberOwnHumanLine } from "./ownHumanLines.js";
import { call } from "./relay-client.js";

/** GET /v1/collabs -> every collab this login is a member of (joined or invited). */
export async function listCollabs() {
  const { data } = await call("/v1/collabs");
  return Array.isArray(data?.collabs) ? data.collabs : [];
}

/**
 * POST /v1/collabs/{id}/accept -- join with THIS session.
 *
 * The invited person is the only one who can do this: the relay checks that the session id belongs
 * to the caller (`ownedSession`), and nobody else knows this session's Claude Code id. So the
 * session joins itself, either when its human chooses it in an interface (which passes the id in)
 * or at start, when the session was opened FROM an invitation (`KWOS_COLLAB`, s. config.js).
 */
export async function acceptCollab(collabId, { mode } = {}) {
  const { data } = await call(`/v1/collabs/${encodeURIComponent(collabId)}/accept`, {
    method: "POST",
    body: { session_id: config.sessionId, ...(mode ? { mode } : {}) },
  });
  return data ?? {};
}

/** POST /v1/collabs/{id}/decline -- the invitation is not for me. */
export async function declineCollab(collabId) {
  const { data } = await call(`/v1/collabs/${encodeURIComponent(collabId)}/decline`, { method: "POST" });
  return data ?? {};
}

/** POST /v1/collabs/{id}/leave -- detach, always allowed. */
export async function leaveCollab(collabId, summary) {
  const path = `/v1/collabs/${encodeURIComponent(collabId)}/leave`;
  // Two shapes on purpose: `call()` serialises whatever it is given, so an empty object would go
  // out as "{}" -- and "{}" is not the same statement as "no body at all" for a route that reads
  // the summary out of it.
  const { data } = await call(path, summary ? { method: "POST", body: { summary } } : { method: "POST" });
  return data ?? {};
}

/**
 * The collabs THIS session is joined to. A person may be in several collabs at once (two
 * workitems, two colleagues) -- and their other session may be in the same one. The member row's
 * session_id is what tells them apart, not the subject.
 */
export async function myJoinedCollabs() {
  const all = await listCollabs();
  return all.filter((c) => c.my_status === "joined"
    && Array.isArray(c.members)
    && c.members.some((m) => m.session_id === config.sessionId && m.status === "joined"));
}

/** The invitations addressed to this login that nobody has answered yet. */
export async function myInvitations() {
  const all = await listCollabs();
  return all.filter((c) => c.my_status === "invited");
}

/**
 * One collab, or an error that says what to do. `collab_id` is optional on purpose: in the common
 * case a session is in exactly one channel, and demanding an id would make Claude read it out of
 * status first -- one more round trip and one more chance for a wrong id. With more than one
 * channel the error NAMES them: picking the first would silently write into the wrong one.
 */
export async function resolveCollab(collabId) {
  const joined = await myJoinedCollabs();
  if (collabId) {
    const hit = joined.find((c) => c.collab_id === collabId);
    if (!hit) throw new Error(`Diese Session ist nicht (mehr) im Collab ${collabId}.`);
    return hit;
  }
  if (joined.length === 1) return joined[0];
  if (joined.length === 0) {
    throw new Error(
      "Diese Session ist in keinem Collab. Ein Collab wird im kwclaude-Fenster angenommen " +
      "(Einladung links in der Sitzungsliste) -- nicht von hier aus."
    );
  }
  const list = joined.map((c) => `${c.collab_id} (Workitem ${c.workitem}${c.title ? `: ${c.title}` : ""})`).join(", ");
  throw new Error(`Diese Session ist in mehreren Collabs -- bitte collab_id angeben: ${list}`);
}

/** GET /v1/collabs/{id} -- the detail the status/lease tools need. */
export async function collabDetail(collabId) {
  const { data } = await call(`/v1/collabs/${encodeURIComponent(collabId)}`);
  return data;
}

/**
 * POST /v1/collabs/{id}/messages -- this session speaks.
 *
 * The KIND is what the other side reads. "claude" is the agent's own sentence, "human" is the
 * person's. `collab_send` passes the human's own words on with `fromHuman: true`, because the pause
 * counter counts agent messages in a row without a human and a relayed order IS the human speaking.
 * The relay trusts the caller for this kind, so the flag says what the input was, it grants nothing.
 */
export async function sendCollabMessage(collabId, text, attachmentId = null, fromHuman = false) {
  const { data } = await call(`/v1/collabs/${encodeURIComponent(collabId)}/messages`, {
    method: "POST",
    body: {
      text: text ?? "",
      author_kind: fromHuman ? "human" : "claude",
      session_id: config.sessionId,
      ...(attachmentId ? { attachment_id: attachmentId } : {}),
    },
  });
  // A line we relayed as the human comes back to us looking exactly like the human's own (s.
  // `ownHumanLines.js`), so it is named here while we still know which line it was.
  if (fromHuman) rememberOwnHumanLine(data?.message?.seq);
  return data ?? {};
}

/** POST /v1/collabs/{id}/attachments -- logs, traces, patches, screenshots. */
export async function uploadCollabAttachment(collabId, { mimeType, filename, dataBase64 }) {
  const { data } = await call(`/v1/collabs/${encodeURIComponent(collabId)}/attachments`, {
    method: "POST",
    body: { mime_type: mimeType, filename, data: dataBase64 },
  });
  return data ?? {};
}

/**
 * GET /v1/collabs/{id}/attachments/{aid} -- raw bytes, not JSON, hence its own fetch. Same shape
 * as getAttachment (relay-client.js) and for the same reason.
 */
export async function getCollabAttachment(collabId, attachmentId, { fetchImpl = fetch } = {}) {
  const bearer = await getAccessToken();
  const res = await fetchImpl(
    `${config.relayUrl}/v1/collabs/${encodeURIComponent(collabId)}/attachments/${encodeURIComponent(attachmentId)}`,
    { headers: { Authorization: `Bearer ${bearer}` } }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Relay GET /v1/collabs/${collabId}/attachments/${attachmentId} -> ${res.status}: ${text}`);
  }
  const mimeType = res.headers.get("content-type") || "application/octet-stream";
  const buf = Buffer.from(await res.arrayBuffer());
  return { mimeType, data: buf.toString("base64") };
}

/** GET /v1/collabs/{id}/leases -- who holds which section right now. */
export async function listLeases(collabId) {
  const { data } = await call(`/v1/collabs/${encodeURIComponent(collabId)}/leases`);
  return Array.isArray(data?.leases) ? data.leases : [];
}

/**
 * POST /v1/collabs/{id}/leases -- reserve a section (advisory; 409 names the holder).
 *
 * The document is named EITHER by `subjectId` (a row the caller already holds, from
 * `collab_status`) OR by `subject {kind, ref}` -- the document itself (WI 11482928, field report
 * 2026-10-20). The second spelling is the one that keeps the human out of it: whoever is writing
 * in a document knows which document it is, and the relay creates the row when it is new.
 *
 * A `ref` is an IDENTITY and not a local path: for a file, the path INSIDE the repository with
 * forward slashes. The relay refuses the backslashes of a Windows path for exactly that reason.
 */
export async function acquireLease(collabId, { subjectId, subject, section, ttlSec, exclusive, reason }) {
  const { data } = await call(`/v1/collabs/${encodeURIComponent(collabId)}/leases`, {
    method: "POST",
    body: {
      ...(subjectId ? { subject_id: subjectId } : {}),
      ...(subject ? { subject } : {}),
      section,
      ...(ttlSec ? { ttl_sec: ttlSec } : {}),
      ...(exclusive === false ? { exclusive: false } : {}),
      ...(reason ? { reason } : {}),
    },
  });
  return data ?? {};
}

/** DELETE /v1/collabs/{id}/leases/{lid} -- release one's own lease (or the maintainer a stuck one). */
export async function releaseLease(collabId, leaseId) {
  await call(`/v1/collabs/${encodeURIComponent(collabId)}/leases/${encodeURIComponent(leaseId)}`, { method: "DELETE" });
}

/** The SSE url of one channel, for the monitor. */
export function collabEventsUrl(collabId) {
  return `${config.relayUrl}/v1/collabs/${encodeURIComponent(collabId)}/events`;
}
