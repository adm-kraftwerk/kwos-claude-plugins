// kwcollab code exchange (WI 11517979) -- the session's view: which collab, who am I, what may I.
//
// The tools (index.js), the hooks (hooks/code-hook.js) and the monitor's serving path all start
// from the same three questions, and they get ONE answer here:
//
//   collab   -- the channel this session is joined to (collab.resolveCollab: the relay knows)
//   me       -- my login IN that channel: the member whose session_id is this session's
//   mandate  -- what my agent may do without asking (stored on the relay, set at join)
//
// The worktree is the session's working directory: `sessionCwd` -- the value config.js read ONCE at
// start -- for the MCP server and the monitor, the hook payload's `cwd` for a hook. Never
// process.cwd(): see codeContext.

import { config, ensureSessionId, sessionCwd } from "./config.js";
import { getAccessToken } from "./auth.js";
import * as collab from "./collab.js";
import * as flow from "./codeExchange.js";
import { relayAdapter, makeFetchLive } from "./codeServe.js";
import { readState, repoInfo } from "./codeGit.js";

export function relay() {
  return relayAdapter({ relayUrl: config.relayUrl, getToken: getAccessToken });
}

export function fetchLive() {
  return makeFetchLive({ relayUrl: config.relayUrl, getToken: getAccessToken });
}

/**
 * The session's code context, or `{ active: false, reason }` -- never a throw for "not in code
 * mode": the hooks run after every turn in every session and must stay silent where there is
 * nothing to do.
 */
export async function codeContext({ cwd = sessionCwd, collabId } = {}) {
  // A worktree the session could not name is not a worktree to guess at (WI 11523603). Nothing here
  // needs process.cwd(): where it cannot be read, config.js chdirs to a fallback to keep later path
  // queries working -- so process.cwd() answers with $HOME or /, and a `git rev-parse` there would
  // describe a repository this session never worked in (measured: the tool call then went to the
  // relay with the fallback directory and answered "fetch failed"). null is the honest answer: no
  // worktree, so no collab in it -- and the caller gets a reason instead of a throw.
  if (!cwd) {
    return { active: false, reason: "Das Arbeitsverzeichnis dieser Sitzung ist nicht lesbar -- ohne es ist kein Worktree zu bestimmen." };
  }
  await ensureSessionId();
  // The worktree knows which collab it exchanges code in (its kwcollab/state.json): that answer
  // beats "the one channel this session is in", which has no answer when the session is in two.
  let local = null;
  try { local = readState((await repoInfo(cwd)).gitDir); } catch { /* no repository here */ }
  let c;
  try { c = await collab.resolveCollab(collabId || local?.collab || (await codeCollabFor(cwd)) || undefined); }
  catch (e) { return { active: false, reason: e.message }; }
  const mine = (c.members || []).find((m) => m.session_id === config.sessionId && m.status === "joined");
  if (!mine) return { active: false, reason: "Diese Session ist im Collab nicht (mehr) eingetragen." };
  const r = relay();
  let state;
  try { state = await r.get(`/v1/collabs/${encodeURIComponent(c.collab_id)}/code`); } catch (e) {
    return { active: false, reason: e.message };
  }
  const meCode = (state.members || []).find((m) => m.subject === mine.subject);
  return {
    active: Boolean(state.code && meCode && local && local.collab === c.collab_id && local.base === state.code.base),
    joined: Boolean(meCode),
    rebaseNeeded: Boolean(state.code && local && local.base !== state.code.base),
    collab: c,
    collabId: c.collab_id,
    me: mine.subject,
    names: Object.fromEntries((c.members || []).map((m) => [m.subject, m.display_name || m.subject])),
    mandate: meCode?.mandate || null,
    code: state.code,
    state,
    local,
    cwd,
    relay: r,
    sessionId: config.sessionId,
  };
}

/**
 * Before a worktree has joined: of the channels this session is in, the ONE whose code mode works
 * on this worktree's repository. Null when there is none or more than one -- then the caller's
 * normal resolution (and its error that names the channels) applies.
 */
async function codeCollabFor(cwd) {
  let repo;
  try { repo = (await repoInfo(cwd)).repo; } catch { return null; }
  if (!repo) return null;
  const joined = await collab.myJoinedCollabs().catch(() => []);
  const hits = joined.filter((c) => c.code?.repo === repo);
  return hits.length === 1 ? hits[0].collab_id : null;
}

/**
 * The end of a turn: publish what changed, take in what the others published, and say it in ONE
 * line -- or nothing. Errors become the line too: a silent failure here would leave two people
 * believing they share a state they do not.
 */
export async function turnEnd({ cwd } = {}) {
  const ctx = await codeContext({ cwd });
  if (!ctx.active) {
    if (ctx.rebaseNeeded) return "kwcollab: Neuer Checkpoint im Kanal -- collab_code_rebase holt die neue Basis.";
    return null;
  }
  const out = [];
  try {
    const pub = await flow.publish(ctx.relay, {
      cwd, collabId: ctx.collabId, identity: { name: ctx.names[ctx.me] || ctx.me }, sessionId: ctx.sessionId, serving: true,
    });
    if (pub.skipped?.length) out.push(`Nicht mitgeschickt (größer als 1 MB): ${pub.skipped.slice(0, 3).join(", ")}`);
  } catch (e) {
    out.push(`Veröffentlichen ging nicht: ${e.message}`);
  }
  try {
    const s = await flow.sync(ctx.relay, {
      cwd, collabId: ctx.collabId, me: ctx.me, mandate: ctx.mandate, sessionId: ctx.sessionId, fetchLive: fetchLive(),
    });
    const line = flow.summaryLine(s.report, ctx.names);
    if (line) out.unshift(line.replace(/^kwcollab: /, "").replace(/\.$/, ""));
  } catch (e) {
    out.push(`Abgleich ging nicht: ${e.message}`);
  }
  // A question to the people stays in front of every person on every turn until one of them answers
  // in the channel -- the work waits for them, and a single mention would scroll away.
  const q = questionLine(ctx.state.questions, ctx.names);
  if (q) out.push(q);
  return out.length ? `kwcollab: ${out.join(". ")}.` : null;
}

/** The open questions as one sentence with their options, or null. */
export function questionLine(questions, names = {}) {
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const q = questions[questions.length - 1];
  const opts = (q.options || []).map((o, i) => `(${i + 1}) ${o}${q.recommend === i ? " [empfohlen]" : ""}`).join(" ");
  const more = questions.length > 1 ? ` (und ${questions.length - 1} weitere offene Frage${questions.length > 2 ? "n" : ""})` : "";
  return `Entscheidung nötig, gestellt von ${names[q.asked_by] || q.asked_by}: ${q.topic} ${opts}${more}. Antworte im Kanal`;
}

/**
 * Before an edit: is there a snapshot of somebody else that changes THIS file and that this
 * worktree has not taken in yet? Then the edit waits for a sync -- otherwise the agent writes into
 * a version of the file that is already outdated, and produces the conflict this exists to avoid.
 *
 * Not a lock: nobody "holds" a file. The answer turns into "go" as soon as the snapshot is in.
 * Returns null (go) or the reason (wait).
 */
export async function precheck({ cwd, path }) {
  const ctx = await codeContext({ cwd });
  if (!ctx.active || !path) return null;
  const info = await repoInfo(cwd);
  const rel = relativeTo(info.top, path);
  if (!rel) return null;
  return editBlocker(ctx.state.members, { me: ctx.me, integrated: ctx.local?.integrated, rel, names: ctx.names, bundles: ctx.state.bundles });
}

/**
 * The pure half of the precheck: which member's not-yet-integrated snapshot touches `rel`? A
 * snapshot whose path list is unknown (`head_paths` null: the relay cut it) counts as touching --
 * the safe direction, it costs one sync.
 *
 * ONLY WHEN A SYNC CAN CHANGE THE ANSWER. A hold names its way out ("collab_code_sync"); a state
 * that cannot be fetched -- its member offline and no bundle for that head -- would hold the file
 * on every turn with no way out (review finding 2026-10-20). Such a state does not hold the edit;
 * the next sync takes it in once it is reachable, and a conflict then follows the normal rule.
 */
export function editBlocker(members, { me, integrated = {}, rel, names = {}, bundles = [] }) {
  for (const m of members || []) {
    if (m.subject === me || !m.head) continue;
    if (integrated?.[m.subject] === m.head) continue;
    if (m.head_paths !== null && !m.head_paths?.includes(rel)) continue;
    const reachable = m.online || (bundles || []).some((b) => b.member === m.subject && b.head === m.head);
    if (!reachable) continue;
    return `${names[m.subject] || m.subject} hat ${rel} in einem Stand geändert, den diese Sitzung noch nicht hat. Erst collab_code_sync, dann bearbeiten.`;
  }
  return null;
}

function relativeTo(top, path) {
  const norm = (s) => String(s).replace(/\\/g, "/").replace(/\/+$/, "");
  const t = norm(top);
  const p = norm(path);
  const tl = t.toLowerCase();
  const pl = p.toLowerCase();
  // Windows paths compare case-insensitively; the repository-relative remainder keeps its case.
  if (process.platform === "win32" ? pl.startsWith(`${tl}/`) : p.startsWith(`${t}/`)) return p.slice(t.length + 1);
  if (!/^([A-Za-z]:)?\//.test(p)) return p;
  return null;
}
