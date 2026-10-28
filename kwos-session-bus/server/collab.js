// kwcollab -- the shared channel on one workitem (WI 11482928, spec in kw/OS 11482928).
//
// The relay side lives in the litellm repo (relay/server.js, routes under /v1/collabs). This file
// is the client: it talks to those routes with the session's own XID identity, and it answers the
// one question every tool and the monitor start with -- WHICH collab is THIS session in?
//
// That question is answered from the relay, never locally: joining is a fact on the server (the
// member row carries the session id), and a local guess would let a session talk into a channel it
// was removed from.
import { config, sessionCwd, refreshSessionId } from "./config.js";
import { getAccessToken } from "./auth.js";
import { rememberOwnHumanLine } from "./ownHumanLines.js";
import { call } from "./relay-client.js";
import { repoInfo } from "./codeGit.js";

/** GET /v1/collabs -> every collab this login is a member of (joined or invited). */
export async function listCollabs() {
  const { data } = await call("/v1/collabs");
  return Array.isArray(data?.collabs) ? data.collabs : [];
}

/**
 * The repository and branch of the session's working directory, or null.
 *
 * The relay stores an agent with the project it works in (`repo` is `repoKey()`, `host/path`), so a
 * person's two sessions can be told apart. A directory without git, or a repository without an
 * origin, is a normal case (a channel outside code mode) and must never cost the join: the answer
 * is simply null and the accept leaves both fields out.
 */
async function sessionRepo(cwd) {
  if (!cwd) return null;
  try {
    const info = await repoInfo(cwd);
    return info.repo ? { repo: info.repo, branch: info.branch } : null;
  } catch {
    return null;
  }
}

/**
 * POST /v1/collabs/{id}/accept -- join with THIS session.
 *
 * The invited person is the only one who can do this: the relay checks that the session id belongs
 * to the caller (`ownedSession`), and nobody else knows this session's Claude Code id. So the
 * session joins itself, either when its human chooses it in an interface (which passes the id in)
 * or at start, when the session was opened FROM an invitation (`KWOS_COLLAB`, s. config.js).
 *
 * The agent also says WHICH REPOSITORY it works in: a person may be in the channel with a second
 * session on another project, and the repository is what tells the two apart afterwards (the
 * sender mark and the code exchange both read it). `cwd` is the seam for tests; the session's own
 * working directory is the default.
 */
export async function acceptCollab(collabId, { mode, cwd = sessionCwd, replaces = null } = {}) {
  const where = await sessionRepo(cwd);
  const { data } = await call(`/v1/collabs/${encodeURIComponent(collabId)}/accept`, {
    method: "POST",
    body: {
      session_id: config.sessionId,
      ...(where?.repo ? { repo: where.repo } : {}),
      ...(where?.branch ? { branch: where.branch } : {}),
      ...(mode ? { mode } : {}),
      // The agent this one REPLACES after /clear or --resume: the relay hands its code state over
      // and removes it, so the person does not read as two agents.
      ...(replaces && replaces !== config.sessionId ? { replaces } : {}),
    },
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
  // THIS ADDRESS leaves, not the whole person (WI 11551159): the relay has a row per session since
  // sessions are addresses under a member. Sending the id is what keeps a second box of the same
  // person in the channel -- and it is also how a web participant (which has no session) stays on
  // the old person-wide shape, because its id is simply absent.
  const body = { ...(config.sessionId ? { session_id: config.sessionId } : {}), ...(summary ? { summary } : {}) };
  const { data } = await call(path, Object.keys(body).length > 0
    ? { method: "POST", body }
    : { method: "POST" });
  return data ?? {};
}

/** The relay's ceiling for a topic's ref (relay/lib.js::COLLAB_TOPIC_REF_MAX). One number for both. */
export const TOPIC_MAX = 300;

/**
 * POST /v1/collabs -- open a channel on a workitem with THIS session (WI 11554174).
 *
 * THE SESSION OPENS IT ITSELF, and that is the reason this belongs here: the relay wants a Claude
 * Code session id that the caller OWNS (`ownedSession`), and the only party that knows its own id is
 * this process (`config.sessionId`, read from the marker, so a /clear is already followed). Until
 * now no party could open a channel from a prompt -- the route existed and the surfaces sent it, so
 * an agent had to ask a human to press `^b z` before it could invite, write or reserve anything.
 *
 * AN OPEN CHANNEL IS NOT A FAILURE, and it is not automatically THIS session's either: the relay
 * allows one per workitem and answers 409 with the id of the one that stands. So the 409 branch
 * tries the join (`acceptCollab`) -- the same act a human's surface performs on an existing channel.
 * It succeeds when this session was invited or is already in; when it does not, the reason comes
 * back as `joined: false` + `joinError` instead of being collected as a 403 "not a member" on the
 * caller's first write.
 *
 * `repo_hint`/`branch_hint` are what the session works in, exactly like the join (`acceptCollab`) --
 * the relay shows them in the channel's head, and a directory without git simply leaves them out.
 */
export async function openCollab({ workitem, title = "", topic = "", cwd = sessionCwd } = {}) {
  const id = String(workitem ?? "").trim();
  if (id === "") throw new Error("Ohne Workitem kein Kanal -- welches Workitem?");
  // THE NEWEST ID FIRST: the marker is the truth across /clear, and the monitor's 5 s check can be
  // 5 s behind a /clear that just happened -- a channel filed on the previous conversation is one
  // this session is no longer in (review of WI 11554174).
  await refreshSessionId();
  // AND IT HAS TO BE A REAL ONE (`config.sessionIdGenerated`): an invented uuid files the channel on a
  // session that no Claude Code process will ever have. Refused where the reason is still known.
  if (config.sessionIdGenerated) {
    throw new Error(
      "Diese Sitzung hat keine echte Claude-Code-Kennung (sie wurde lokal erzeugt) -- ein Kanal " +
        "unter ihr gehoerte keiner Sitzung, und diese waere nach der ersten echten Kennung nicht " +
        "mehr drin. Erst oeffnen, wenn Claude Code eine Kennung liefert."
    );
  }
  const where = await sessionRepo(cwd);
  const head = String(title ?? "").trim();
  const subject = String(topic ?? "").trim();
  const body = {
    workitem: id,
    session_id: config.sessionId,
    ...(head ? { title: head.slice(0, 300) } : {}),
    ...(where?.repo ? { repo_hint: where.repo } : {}),
    ...(where?.branch ? { branch_hint: where.branch } : {}),
    // A topic is a SUBJECT and not a head field (the relay already takes `subjects`, and a topic
    // needs no lease). Empty means no topic -- an agenda of "" is not an agenda.
    ...(subject ? { subjects: [{ kind: "topic", ref: subject.slice(0, TOPIC_MAX) }] } : {}),
  };
  try {
    const { data } = await call("/v1/collabs", { method: "POST", body });
    const opened = data?.collab?.collab_id;
    // A channel that was created but cannot be named is worse than an error: the caller would go on
    // to invite into nothing. Said here, where the reason is still known.
    if (typeof opened !== "string" || opened === "") {
      throw new Error("Der Relay hat den Kanal angelegt, aber keine collab_id genannt.");
    }
    return { collab_id: opened, workitem: id, existed: false };
  } catch (e) {
    const existing = e?.status === 409 ? String(e?.body?.collab_id ?? "") : "";
    if (existing === "") throw e;
    // WHO TO ASK, from the same answer (WI 11569154): a channel on this workitem that this session
    // is not in is a dead end unless the sentence names the one person who can let it in.
    const lead = typeof e?.body?.maintainer === "string" ? e.body.maintainer.trim() : "";
    // A CHANNEL THAT STANDS IS NOT ONE THIS SESSION IS IN (review of WI 11554174). Writing,
    // reserving and inviting all need `joined`, and the relay adds the opener only when it CREATES
    // the channel -- a 409 means somebody else got there first, or this session called twice.
    // Joining is the same act a human's surface performs when it opens an existing channel; a
    // refusal is an answer too, and it is worth more than the 403 the caller would otherwise
    // collect on its first write.
    try {
      await acceptCollab(existing, { cwd });
      return { collab_id: existing, workitem: id, existed: true, joined: true };
    } catch (joinError) {
      return {
        collab_id: existing,
        workitem: id,
        existed: true,
        joined: false,
        joinError: joinError?.message ?? String(joinError),
        maintainer: lead === "" ? null : lead,
      };
    }
  }
}

/**
 * The collabs THIS session is joined to. A person may be in several collabs at once (two
 * workitems, two colleagues) -- and the SAME person may have several sessions in one of them.
 *
 * The answer is per ADDRESS (WI 11551159): the relay hands out `sessions` per member, and this
 * session is in a channel when its own id is among them. Reading `member.session_id` alone was the
 * column for "who bound last", so a second session took the channel away from the first.
 */
export async function myJoinedCollabs() {
  const all = await listCollabs();
  return all.filter((c) => c.my_status === "joined"
    && Array.isArray(c.members)
    && c.members.some((m) => m.status === "joined" && memberHasSession(m, config.sessionId)));
}

/**
 * Is this member in the channel with exactly this session? Prefers `agents`, then the older
 * `sessions`, then the old single column (the session that bound last).
 */
export function memberHasSession(member, sessionId) {
  if (!member || !sessionId) return false;
  if (Array.isArray(member.agents)) return member.agents.some((a) => a?.session_id === sessionId);
  if (Array.isArray(member.sessions)) return member.sessions.some((s) => s?.session_id === sessionId);
  return member.session_id === sessionId;
}

/**
 * The code-state entry of ONE address (`GET /code` lists one entry per session), or null.
 *
 * No fallback to another session of the same person: two sessions may be on two projects, and
 * taking the sibling's entry would hand this session a foreign plane, head and mandate. A session
 * that is not on a plane is simply not in code mode.
 */
export function codeEntryFor(entries, subject, sessionId) {
  if (!subject || !sessionId) return null;
  return (entries || []).find((m) => m?.subject === subject && m?.session_id === sessionId) ?? null;
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
      "Diese Session ist in keinem Collab. Ein offener Kanal auf ihrem Workitem steht dir offen " +
      "(collab_open); eine EINLADUNG wird im kwclaude-Fenster angenommen " +
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
 * The relay's ceiling for a line's short form (relay/lib.js::COLLAB_SUMMARY_MAX). One number for
 * both sides: the relay refuses anything longer, so the client must not be able to produce it.
 */
export const SUMMARY_MAX = 280;

/**
 * The short form as the relay will accept it: ONE line, at most SUMMARY_MAX characters, or null.
 *
 * It is clamped HERE and not at the relay, because the relay's 400 is the wrong trade: the brief is
 * a courtesy for the readers, and a model that writes two sentences (or one long one) must lose the
 * summary, never the message it belongs to. Whitespace -- newlines included -- folds to single
 * spaces; an overlong sentence is cut at a word boundary and ends on an ellipsis, so the reader can
 * see that something was cut.
 */
export function clampSummary(value, max = SUMMARY_MAX) {
  if (typeof value !== "string") return null;
  const line = value.replace(/\s+/g, " ").trim();
  if (line === "") return null;
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * POST /v1/collabs/{id}/messages -- this session speaks.
 *
 * The KIND is what the other side reads. "claude" is the agent's own sentence, "human" is the
 * person's. `collab_send` passes the human's own words on with `fromHuman: true`, because the pause
 * counter counts agent messages in a row without a human and a relayed order IS the human speaking.
 * The relay trusts the caller for this kind, so the flag says what the input was, it grants nothing.
 *
 * The SHORT FORM (WI 11538037) rides along when the caller wrote one: the surfaces fold a long line
 * down to it and keep the text behind a disclose, so a pasted diff no longer pushes the rest of the
 * channel off the screen. It is a courtesy, not a condition -- a line without one still arrives, and
 * the surfaces then take its first sentence. An older relay ignores the field entirely.
 */
export async function sendCollabMessage(collabId, text, attachmentId = null, fromHuman = false, summary = null) {
  const brief = clampSummary(summary);
  const { data } = await call(`/v1/collabs/${encodeURIComponent(collabId)}/messages`, {
    method: "POST",
    body: {
      text: text ?? "",
      author_kind: fromHuman ? "human" : "claude",
      session_id: config.sessionId,
      ...(attachmentId ? { attachment_id: attachmentId } : {}),
      ...(brief !== null ? { summary: brief } : {}),
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

/**
 * GET /v1/collabs/{id}/messages/{seq} -- ONE message of the channel, full text (WI 11536314).
 *
 * The counterpart to the split monitor line: the line carries the message's `seq` in its head
 * ("[kwcollab <short>:<seq> | ...]"), and this fetches the whole text behind it. Same access guard
 * as the channel detail route on the relay side (membership), 404 for an unknown or swept seq --
 * `call()` turns both into a sentence, so a refusal is never mistaken for an empty message.
 *
 * The text is NOT re-split here: it is the answer to a question, not a monitor line, and a tool
 * result is not cut by the harness.
 */
export async function getCollabMessage(collabId, seq) {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new Error(`collab_get_message: seq muss eine positive Ganzzahl sein (erhalten: ${JSON.stringify(seq)}).`);
  }
  const { data } = await call(`/v1/collabs/${encodeURIComponent(collabId)}/messages/${encodeURIComponent(seq)}`);
  // The route answers with the message under `message` (the same envelope as POST .../messages).
  // A bare message object is accepted too: the route is new, and a shape this client cannot read
  // would otherwise look like an empty message.
  return data?.message ?? data ?? {};
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

// ── Inviting (2026-10-25, WI 11553520) ───────────────────────────────────────────────────────
//
// Until now an agent could only invite through `kwclaude invite`, which is a chain through the
// LOCAL kwterm server: CLI → unix socket → the server process, because only that process knew the
// session's workitem and the person catalog. A session without a running kwterm server could not
// invite at all -- and the session itself already holds everything: the relay knows which channels
// this login is in, and `/v1/people` answers the person search with the same token.
//
// NOTHING IS DECIDED HERE. The relay judges: only the maintainer invites, not yourself, not twice,
// and its two budgets apply. This file resolves names and makes one POST.

/** The person search the invite field uses: GET /v1/people?q= (relay, with this person's token). */
export async function searchPeople(query, workitem = config.workitem) {
  const q = String(query ?? "").trim();
  // Same threshold as the relay (`okPeopleQuery`): one letter matches half the company.
  if (q.length < 2) return [];
  // THE WORKITEM NARROWS THE LIST TO PEOPLE WHO CAN ACCEPT (WI 11569154). Without it the roster
  // offered colleagues whose access nobody had checked, and the invitation failed at ACCEPT -- on
  // the invited person's side, who can do nothing about a 403.
  const narrow = /^\d{5,}$/.test(String(workitem ?? "").trim())
    ? `&workitem=${encodeURIComponent(String(workitem).trim())}`
    : "";
  const { data } = await call(`/v1/people?q=${encodeURIComponent(q)}${narrow}`);
  return Array.isArray(data?.people) ? data.people : [];
}

/** Accent- and umlaut-insensitive folding, the same rules the relay and the picker use. */
const foldText = (s) => String(s ?? "")
  .normalize("NFD")
  .replace(/[̀-ͯ]/g, "")
  .replace(/ß/g, "ss")
  .toLowerCase();

/**
 * Which ONE person does `query` name?
 *
 * A LOGIN wins outright -- it is the identity, and two people cannot share one. A NAME has to match
 * exactly as a set of words ("Alex Beispiel" and "Beispiel, Alex" are the same person; "Alex
 * Beispiel-Klein" is not). Anything else is a question, not a guess: `chosen` stays null and the
 * candidates travel back so the caller can name them.
 *
 * Deliberately STRICTER than the relay's suggestion list, which folds ae/oe/ue so that a name typed
 * with plain letters still finds the one spelled with umlauts. For a suggestion that is right; for
 * picking the person who will get an invitation it is not -- two different surnames must not
 * collapse into one.
 */
export function resolveInvitee(people, query) {
  const q = String(query ?? "").trim();
  const rows = Array.isArray(people) ? people.filter((p) => p && typeof p.login === "string" && p.login) : [];
  if (q === "") return { chosen: null, matches: rows };
  const loginKey = q.toLowerCase();
  const byLogin = rows.filter((p) => p.login.toLowerCase() === loginKey);
  if (byLogin.length === 1) return { chosen: byLogin[0], matches: byLogin };
  const wanted = foldText(q).split(/[\s,]+/).filter(Boolean);
  const exact = rows.filter((p) => {
    const words = foldText(p.name ?? p.login).split(/[\s,]+/).filter(Boolean);
    return words.length === wanted.length && wanted.every((w) => words.includes(w));
  });
  if (exact.length === 1) return { chosen: exact[0], matches: exact };
  // No exact hit: hand back what the search DID find, so the caller can offer the logins.
  const loose = rows.filter((p) => wanted.every((w) => foldText(`${p.name ?? ""} ${p.login}`).includes(w)));
  return { chosen: null, matches: exact.length > 1 ? exact : loose };
}

/** POST /v1/collabs/{id}/invites -- the relay decides whether this person may invite at all. */
export async function inviteToCollab(collabId, subject, note) {
  const text = typeof note === "string" ? note.trim() : "";
  const { data } = await call(`/v1/collabs/${encodeURIComponent(collabId)}/invites`, {
    method: "POST",
    body: { subject, ...(text ? { note: text.slice(0, 2000) } : {}), via: "claude" },
  });
  return data ?? {};
}
