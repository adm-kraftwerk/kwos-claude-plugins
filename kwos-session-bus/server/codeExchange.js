// kwcollab code exchange (WI 11517979) -- the flow of one session.
//
//   start      maintainer: switch code mode on for this repository and branch
//   join       a member: enter code mode with a mandate (what the agent may do without asking)
//   publish    record the worktree as a snapshot, upload its bundle, announce it
//   sync       fetch every newer snapshot of the others and merge it in, as far as the mandate allows
//   resolved   after resolving a conflict by hand: check the markers are gone, publish, report
//   checkpoint commit + push the shared state; it becomes the new base for everybody
//   status     where everybody stands
//
// Git is in codeGit.js, the relay in `relay` (injected: an object with get/post/put/postRaw/getRaw).
// The relay rules this flow depends on (who resolves a conflict, bundle on the base, one bundle per
// member) live in the litellm repo, relay/collabCode.js -- this file follows them, it does not
// re-decide them.

import {
  git, gitText, checkGitVersion, repoInfo, readState, writeState, outRef, inRef, buildSnapshot,
  changedFiles, findSecrets, createBundle, importBundle, mergeTrees, isAncestor, applyTree,
  worktreeTree, filesWithMarkers, inArea,
} from "./codeGit.js";

const enc = encodeURIComponent;

/**
 * The stable name of ONE address in the code state: `subject#session` when the entry carries a
 * session, else the subject. Two sessions of one person are two working states and must not
 * collide in local state (integrated map, conflicts list) or in the event payloads that name them.
 */
const memberAddr = (m) => (m?.session_id ? `${m.subject}#${m.session_id}` : m?.subject);

/** Is this entry THIS session? A legacy entry without a session id is the person's one address. */
function isOwnAddress(m, me, sessionId) {
  if (!m || m.subject !== me) return false;
  if (m.session_id == null) return true;
  return m.session_id === sessionId;
}

/** The stable name of a bundle's owner: `subject#session`, or the subject for a legacy bundle. */
const bundleAddr = (b) => {
  const subject = b?.member_subject ?? b?.member;
  return b?.member_session ? `${subject}#${b.member_session}` : subject;
};

function bundlesByAddress(bundles) {
  const map = new Map();
  for (const b of bundles || []) {
    const key = bundleAddr(b);
    if (key) map.set(key, b);
  }
  return map;
}

/**
 * The bundle of THIS address. A bundle without a session is the person's default one (a row from
 * before code state moved per session); it is only taken when no bundle for the address exists.
 */
function bundleFor(map, m) {
  return map.get(memberAddr(m)) ?? map.get(m?.subject) ?? null;
}

/** Everything the flow needs to know about the local side. */
export async function localContext(cwd, collabId) {
  await checkGitVersion(cwd);
  const info = await repoInfo(cwd);
  if (!info.repo) throw new Error("Dieses Repository hat kein `origin` -- der Code-Modus braucht einen gemeinsamen Remote.");
  const state = readState(info.gitDir);
  if (state && collabId && state.collab !== collabId) {
    throw new Error(`Dieser Worktree tauscht schon im Collab ${state.collab} Code aus.`);
  }
  return { ...info, state };
}

/**
 * The channel's code state AS THIS AGENT SEES IT. The session goes along, so `code` and `members`
 * describe this agent's own plane -- without it the relay answers for the person's last-bound
 * agent, which may be on another repository (two agents of one person, STREAM and BC).
 */
async function codeState(relay, collabId, sessionId = null) {
  const q = sessionId ? `?session=${enc(sessionId)}` : "";
  return relay.get(`/v1/collabs/${enc(collabId)}/code${q}`);
}

/**
 * The plane this worktree belongs to: same repository and, when the channel has several planes on
 * it, the same branch. Null when the channel has none for this project yet.
 */
export function planeForWorktree(cur, repo, branch) {
  const planes = Array.isArray(cur?.planes) ? cur.planes : [];
  const forRepo = planes.filter((p) => p.repo === repo);
  if (forRepo.length === 0) {
    // A relay from before planes answers only `code` -- one project per channel.
    return cur?.code && cur.code.repo === repo ? { ...cur.code, id: null } : null;
  }
  return forRepo.find((p) => p.branch === branch) || (forRepo.length === 1 ? forRepo[0] : null);
}

// The base must be in the local object store before anything can build on it.
async function ensureBase(top, branch, base) {
  const have = await git(top, ["cat-file", "-e", `${base}^{commit}`]);
  if (have.code === 0) return;
  const r = await git(top, ["fetch", "-q", "--no-tags", "origin", branch]);
  if (r.code !== 0) throw new Error(`git fetch origin ${branch} schlug fehl: ${r.stderr.trim()}`);
  const again = await git(top, ["cat-file", "-e", `${base}^{commit}`]);
  if (again.code !== 0) throw new Error(`Die Basis ${base.slice(0, 7)} ist auf origin/${branch} nicht zu finden.`);
}

function freshState(collab, me, base, branch) {
  return { collab, me, base, branch, last: null, integrated: {}, pending: [], conflicts: [] };
}

/**
 * Maintainer: code mode on. The base is the current HEAD, which must be on origin already (the
 * others fetch it from there) -- a local commit as base would make every bundle unusable for them.
 */
export async function start(relay, { cwd, collabId, me, mandate, sessionId }) {
  const ctx = await localContext(cwd, collabId);
  if (!ctx.branch) throw new Error("HEAD ist kein Branch -- der Code-Modus arbeitet auf einem Branch.");
  const r = await git(ctx.top, ["fetch", "-q", "--no-tags", "origin", ctx.branch]);
  if (r.code !== 0) throw new Error(`git fetch origin ${ctx.branch} schlug fehl: ${r.stderr.trim()}`);
  const remoteHead = await gitText(ctx.top, ["rev-parse", "FETCH_HEAD"]);
  if (!(await isAncestor(ctx.top, ctx.head, remoteHead))) {
    throw new Error(`HEAD ${ctx.head.slice(0, 7)} liegt nicht auf origin/${ctx.branch}. Erst pushen, dann den Code-Modus starten.`);
  }
  const res = await relay.post(`/v1/collabs/${enc(collabId)}/code`, {
    repo: ctx.repo, branch: ctx.branch, base: ctx.head, mandate, ...(sessionId ? { session_id: sessionId } : {}),
  });
  const base = res.code.base;
  await ensureBase(ctx.top, ctx.branch, base);
  writeState(ctx.gitDir, ctx.state?.base === base ? ctx.state : freshState(collabId, me, base, ctx.branch));
  return { repo: ctx.repo, branch: ctx.branch, base, mandate: res.mandate };
}

/** Member: enter code mode. Same repository, base fetched from origin, then everyone's state in. */
export async function join(relay, { cwd, collabId, me, mandate, sessionId }) {
  const ctx = await localContext(cwd, collabId);
  const cur = await codeState(relay, collabId, sessionId);
  // The plane of THIS repository -- a channel may carry several projects, one per plane.
  const plane = planeForWorktree(cur, ctx.repo, ctx.branch);
  if (!plane) {
    const known = (Array.isArray(cur?.planes) ? cur.planes : []).map((p) => `${p.repo} ${p.branch}`).join(", ");
    throw new Error(known
      ? `Fuer ${ctx.repo} laeuft in diesem Collab noch kein Code-Austausch (laufend: ${known}). collab_code_start oeffnet ihn fuer dieses Projekt.`
      : "Der Code-Modus ist in diesem Collab noch nicht eingeschaltet.");
  }
  // The branch goes along: two planes on one repository (two branches) are ambiguous without it.
  const res = await relay.put(`/v1/collabs/${enc(collabId)}/code/mandate`, {
    repo: ctx.repo, branch: plane.branch, mandate, ...(sessionId ? { session_id: sessionId } : {}),
  });
  cur.code = { repo: plane.repo, branch: plane.branch, base: plane.base };
  await ensureBase(ctx.top, cur.code.branch, cur.code.base);
  if (!(await isAncestor(ctx.top, cur.code.base, ctx.head)) && !(await isAncestor(ctx.top, ctx.head, cur.code.base))) {
    throw new Error(`Dieser Worktree steht nicht auf der Basis ${cur.code.base.slice(0, 7)} (${cur.code.branch}). Erst \`git checkout ${cur.code.branch}\` bzw. auf die Basis wechseln.`);
  }
  if (!ctx.state || ctx.state.base !== cur.code.base) writeState(ctx.gitDir, freshState(collabId, me, cur.code.base, cur.code.branch));
  return { repo: ctx.repo, branch: cur.code.branch, base: cur.code.base, mandate: res.mandate };
}

/**
 * Publish this worktree. Returns `{ published: false }` when nothing changed since the last
 * snapshot. Blocks (throws) when the diff carries something that looks like a credential.
 */
export async function publish(relay, { cwd, collabId, identity, sessionId, serving = false, duringResolve = false }) {
  const ctx = await localContext(cwd, collabId);
  const st = ctx.state;
  if (!st) throw new Error("Dieser Worktree ist nicht im Code-Modus (erst start/join).");
  // While this worktree holds conflict markers it resolves, nothing leaves it: a snapshot with
  // `<<<<<<<` would merge cleanly into a waiting member's worktree (their side did not change), and
  // the markers would land exactly where the protocol tells them not to touch. Only `resolved()`
  // publishes during a conflict -- after it checked the markers are gone.
  if (st.conflicts.length > 0 && !duringResolve) {
    return { published: false, head: st.last || st.base, skipped: [], held: st.conflicts.map((c) => c.member) };
  }
  const parents = [st.last || st.base, ...st.pending.filter((p) => p !== st.last)];
  const snap = await buildSnapshot(ctx.top, ctx.gitDir, { collab: collabId, base: st.base, parents, identity });
  if (!snap.changed) return { published: false, head: st.last || st.base, skipped: snap.skipped };
  const secrets = await findSecrets(ctx.top, st.base, snap.head);
  if (secrets.length > 0) {
    const where = secrets.slice(0, 5).map((s) => `${s.path}:${s.line} (${s.text})`).join("; ");
    const err = new Error(`Nicht veröffentlicht: mögliche Zugangsdaten in ${where}. Stelle entfernen oder die Datei in .kwcollabignore eintragen.`);
    err.secrets = secrets;
    throw err;
  }
  const prevOut = await git(ctx.top, ["rev-parse", "--verify", "-q", outRef(collabId)]);
  await gitText(ctx.top, ["update-ref", outRef(collabId), snap.head, ...(prevOut.code === 0 ? [prevOut.stdout.toString().trim()] : [])]);
  const bytes = await createBundle(ctx.top, collabId, st.base);
  // The bundle belongs to THIS address: two sessions of one person publish their own snapshots,
  // and without the session the relay would file one on top of the other.
  const up = await relay.postRaw(
    `/v1/collabs/${enc(collabId)}/code/bundles${sessionId ? `?session=${enc(sessionId)}` : ""}`,
    bytes,
    {
      "Content-Type": "application/x-git-bundle",
      "X-Kwcollab-Head": snap.head,
      "X-Kwcollab-Prereqs": st.base,
      ...(sessionId ? { "X-Kwcollab-Session": sessionId } : {}),
    }
  );
  const all = await changedFiles(ctx.top, st.base, snap.head);
  const files = all.slice(0, 500);
  await relay.post(`/v1/collabs/${enc(collabId)}/code/events`, {
    session_id: sessionId,
    payload: {
      type: "snapshot", head: snap.head, base: st.base, parents, files, files_total: all.length,
      bundle_id: up.bundle.bundle_id, serve: serving,
    },
  });
  writeState(ctx.gitDir, { ...st, last: snap.head, pending: [] });
  return { published: true, head: snap.head, files: all, skipped: snap.skipped };
}

// Bring one member's snapshot into the local object store: live from their serving session when it
// is online, otherwise from their bundle.
async function fetchMember(relay, ctx, collabId, member, fetchLive) {
  if (member.online && fetchLive) {
    try {
      // The live fetch names the TARGET address (`?session=`) so the serving stream of the right
      // session answers; the caller's own address travels as a header.
      const head = await fetchLive(ctx, collabId, { subject: member.subject, sessionId: member.session_id });
      if (head === member.head) return { head, via: "live" };
    } catch { /* fall through to the bundle */ }
  }
  if (!member.bundle_id) throw new Error(`Der Stand von ${member.subject} ist gerade nicht abrufbar (kein Bundle, nicht online).`);
  const bundle = await relay.getRaw(`/v1/collabs/${enc(collabId)}/code/bundles/${enc(member.bundle_id)}`);
  const head = await importBundle(ctx.top, ctx.gitDir, collabId, member.subject, bundle);
  return { head, via: "bundle" };
}

/**
 * Pull everyone's newer snapshots in. For each member with a head this worktree has not integrated:
 *
 *   - already contained (their head is an ancestor of ours)  -> nothing to do, recorded
 *   - merge clean                                            -> applied (mandate apply != never)
 *   - merge with conflicts:
 *       an open conflict exists for the pair -> follow it: resolver resolves, the other waits
 *       none yet -> report one; the relay answers with the decision that stands
 *     resolving = markers written into the worktree for the agent to edit (mandate apply=resolve,
 *     or apply=clean outside one's own area); otherwise escalate
 *
 * Returns a report the hooks turn into ONE summary line.
 */
export async function sync(relay, { cwd, collabId, me, mandate, sessionId, fetchLive, only }) {
  const ctx = await localContext(cwd, collabId);
  let st = ctx.state;
  if (!st) throw new Error("Dieser Worktree ist nicht im Code-Modus (erst start/join).");
  const cur = await codeState(relay, collabId, sessionId);
  if (!cur.code) throw new Error("Der Code-Modus ist in diesem Collab aus.");
  if (cur.code.base !== st.base) {
    return { rebase: true, base: cur.code.base, report: [{ kind: "rebase", base: cur.code.base }] };
  }
  const bundlesByAddr = bundlesByAddress(cur.bundles);
  const report = [];
  // ADDRESSES, not people: the sibling session of this person is another member of the exchange
  // and integrates like anybody else. Only this very session is skipped.
  const others = (cur.members || [])
    .filter((m) => !isOwnAddress(m, me, sessionId) && m.head && (!only || m.subject === only));
  for (const m of others) {
    const ref = memberAddr(m);
    if (st.integrated[ref] === m.head) continue;
    const bundle = bundleFor(bundlesByAddr, m);
    // Only a bundle that carries exactly the announced head; an older one would integrate a state
    // the member has already moved on from.
    const usable = bundle && bundle.head === m.head ? bundle : null;
    if (!usable && !m.online) { report.push({ kind: "unavailable", member: m.subject }); continue; }
    let fetched;
    try {
      fetched = await fetchMember(relay, ctx, collabId, { ...m, bundle_id: usable?.bundle_id }, fetchLive);
    } catch (e) {
      // One member out of reach must not stop the others from being taken in.
      report.push({ kind: "unavailable", member: m.subject, reason: e.message });
      continue;
    }
    const theirs = fetched.head;
    // What this worktree holds right now, as a commit on top of our last snapshot.
    const ours = await buildSnapshot(ctx.top, ctx.gitDir, {
      collab: collabId, base: st.base, parents: [st.last || st.base, ...st.pending.filter((p) => p !== st.last)],
      identity: { name: me },
    });
    if (await isAncestor(ctx.top, theirs, ours.head)) {
      st = { ...st, integrated: { ...st.integrated, [ref]: theirs } };
      writeState(ctx.gitDir, st);
      report.push({ kind: "contained", member: m.subject, head: theirs });
      continue;
    }
    const merged = await mergeTrees(ctx.top, ours.head, theirs);
    const files = (await changedFiles(ctx.top, ours.head, merged.tree)).map((f) => f.path);
    if (merged.clean) {
      if (mandate.apply === "never") { report.push({ kind: "waiting", member: m.subject, head: theirs, files }); continue; }
      const applied = await applyTree(ctx.top, ctx.gitDir, ours.tree, merged.tree);
      if (!applied.applied) { report.push({ kind: "retry", member: m.subject, reason: applied.reason }); continue; }
      st = { ...st, integrated: { ...st.integrated, [ref]: theirs }, pending: [...new Set([...st.pending, theirs])] };
      writeState(ctx.gitDir, st);
      await relay.post(`/v1/collabs/${enc(collabId)}/code/events`, {
        session_id: sessionId,
        payload: { type: "integrated", from_member: m.subject, from_session: m.session_id ?? null, head: theirs, result: "clean", paths: files.slice(0, 500) },
      });
      report.push({ kind: "integrated", member: m.subject, head: theirs, files, via: fetched.via });
      continue;
    }
    // Conflict. Who resolves is the relay's standing decision for this pair, or ours to propose.
    // The pair is two ADDRESSES: two sessions of one person conflict as separately as two people.
    const ownRef = memberAddr({ subject: me, session_id: sessionId });
    const standing = (cur.conflicts || []).find((c) => (Array.isArray(c.refs)
      ? c.refs.includes(ownRef) && c.refs.includes(ref)
      : (c.members || []).includes(me) && (c.members || []).includes(m.subject)));
    let decision = standing;
    if (!decision) {
      const mineSeq = (cur.members.find((x) => memberAddr(x) === ownRef) || {}).head_seq ?? 0;
      const laterIsMe = mineSeq > (m.head_seq ?? 0);
      const myArea = merged.conflicts.every((p) => inArea(mandate.area, p));
      // The later publisher resolves, unless the conflict lies in this session's own area -- then
      // the other address does. Tracked per ADDRESS: with two sessions of one person the subject
      // alone cannot say which one is meant.
      const resolverIsMe = laterIsMe && !myArea;
      const resolver = resolverIsMe ? me : m.subject;
      const resolverSession = resolverIsMe ? (sessionId ?? null) : (m.session_id ?? null);
      const res = await relay.post(`/v1/collabs/${enc(collabId)}/code/events`, {
        session_id: sessionId,
        payload: {
          type: "conflict", with_member: m.subject, with_session: m.session_id ?? null,
          with_head: theirs, own_head: ours.head, resolver, resolver_session: resolverSession,
          paths: merged.conflicts.slice(0, 500),
        },
      });
      decision = res.conflict;
    }
    // Same person, other address is NOT the same resolver: the relay names the address, and only
    // that one resolves.
    const iResolve = decision?.resolver === me
      && (!decision?.resolver_session || decision.resolver_session === sessionId);
    if (!iResolve) {
      report.push({ kind: "waiting_for_resolver", member: m.subject, resolver: decision?.resolver, paths: merged.conflicts });
      continue;
    }
    const ownArea = merged.conflicts.some((p) => inArea(mandate.area, p));
    const mayResolve = mandate.apply === "resolve" || (mandate.apply === "clean" && !ownArea);
    if (!mayResolve) {
      report.push({ kind: "escalate", member: m.subject, paths: merged.conflicts, reason: ownArea ? "conflict_in_area" : "mandate" });
      continue;
    }
    const applied = await applyTree(ctx.top, ctx.gitDir, ours.tree, merged.tree);
    if (!applied.applied) { report.push({ kind: "retry", member: m.subject, reason: applied.reason }); continue; }
    st = {
      ...st,
      pending: [...new Set([...st.pending, theirs])],
      conflicts: [
        ...st.conflicts.filter((c) => (c.ref ?? memberAddr({ subject: c.member, session_id: c.session })) !== ref),
        { member: m.subject, session: m.session_id ?? null, ref, head: theirs, paths: merged.conflicts },
      ],
    };
    writeState(ctx.gitDir, st);
    await relay.post(`/v1/collabs/${enc(collabId)}/code/events`, {
      session_id: sessionId,
      payload: { type: "adapt", to_head: theirs, with_member: m.subject, with_session: m.session_id ?? null },
    });
    report.push({ kind: "resolve", member: m.subject, head: theirs, paths: merged.conflicts });
  }
  return { rebase: false, report };
}

/** After resolving: no markers left, then publish and report the conflicts as resolved. */
export async function resolved(relay, { cwd, collabId, identity, sessionId }) {
  const ctx = await localContext(cwd, collabId);
  const st = ctx.state;
  if (!st || st.conflicts.length === 0) return { resolved: [], published: false };
  const paths = [...new Set(st.conflicts.flatMap((c) => c.paths))];
  const left = await filesWithMarkers(ctx.top, paths);
  if (left.length > 0) throw new Error(`Noch Konfliktmarker in: ${left.join(", ")}`);
  const pub = await publish(relay, { cwd, collabId, identity, sessionId, duringResolve: true });
  // A conflict from a rebase onto a checkpoint is this worktree's own business -- no member to tell.
  for (const c of st.conflicts.filter((x) => x.member !== "checkpoint")) {
    await relay.post(`/v1/collabs/${enc(collabId)}/code/events`, {
      session_id: sessionId,
      payload: {
        type: "integrated", from_member: c.member, from_session: c.session ?? null,
        head: c.head, result: "resolved", paths: c.paths.slice(0, 500),
      },
    });
  }
  const after = readState(ctx.gitDir);
  writeState(ctx.gitDir, {
    ...after,
    integrated: {
      ...after.integrated,
      ...Object.fromEntries(st.conflicts
        .filter((c) => c.member !== "checkpoint")
        .map((c) => [c.ref ?? memberAddr({ subject: c.member, session_id: c.session }), c.head])),
    },
    conflicts: [],
  });
  return { resolved: st.conflicts.map((c) => c.member), published: pub.published, head: pub.head };
}

/**
 * Checkpoint: the merged state becomes a real commit on the branch (through the repository's own
 * commit hooks), pushed, and the new base for everybody. `runChecks` runs the project's tests on the
 * merged worktree first -- git does not see two plans that contradict each other.
 */
export async function checkpoint(relay, { cwd, collabId, me, mandate, message, coAuthors = [], sessionId, runChecks, fetchLive }) {
  const ctx = await localContext(cwd, collabId);
  const st = ctx.state;
  if (!st) throw new Error("Dieser Worktree ist nicht im Code-Modus.");
  const before = await sync(relay, { cwd, collabId, me, mandate, sessionId, fetchLive });
  if (before.rebase) throw new Error("Jemand hat schon einen Checkpoint gemacht -- erst auf die neue Basis wechseln.");
  const blocking = before.report.filter((r) => ["waiting_for_resolver", "escalate", "resolve", "retry", "unavailable", "waiting"].includes(r.kind));
  if (blocking.length > 0 || readState(ctx.gitDir).conflicts.length > 0) {
    throw new Error(`Kein Checkpoint, solange Stände fehlen oder Konflikte offen sind: ${blocking.map((b) => `${b.member} (${b.kind})`).join(", ") || "Konflikte"}`);
  }
  if (runChecks) await runChecks(ctx.top);
  if (ctx.branch !== st.branch) throw new Error(`HEAD steht auf ${ctx.branch}, der Collab arbeitet auf ${st.branch}.`);
  // HEAD must still be the base: a local commit in between would be pushed along unseen by the others.
  if (ctx.head !== st.base) throw new Error(`HEAD ${ctx.head.slice(0, 7)} ist nicht mehr die Basis ${st.base.slice(0, 7)}.`);
  await gitText(ctx.top, ["add", "-A"]);
  const trailers = [...new Set(coAuthors)].map((a) => `Co-authored-by: ${a}`).join("\n");
  const commit = await git(ctx.top, ["commit", "-q", "-m", trailers ? `${message}\n\n${trailers}` : message]);
  if (commit.code !== 0) throw new Error(`git commit schlug fehl (Commit-Hook?): ${(commit.stderr.toString() || commit.stdout.toString()).trim().split("\n").slice(-5).join(" ")}`);
  const sha = await gitText(ctx.top, ["rev-parse", "HEAD"]);
  const push = await git(ctx.top, ["push", "-q", "origin", `HEAD:refs/heads/${st.branch}`]);
  if (push.code !== 0) {
    // Not a fast-forward: somebody else checkpointed first. Undo the local commit, keep the files.
    await gitText(ctx.top, ["reset", "-q", "--soft", "HEAD~1"]);
    await gitText(ctx.top, ["reset", "-q"]);
    throw new Error(`Push abgelehnt (${push.stderr.trim().split("\n").slice(-1)[0]}). Wahrscheinlich war jemand schneller -- Commit zurückgenommen, Dateien bleiben.`);
  }
  await relay.post(`/v1/collabs/${enc(collabId)}/code/events`, { session_id: sessionId, payload: { type: "checkpoint", sha, branch: st.branch } });
  await git(ctx.top, ["update-ref", "-d", outRef(collabId)]);
  writeState(ctx.gitDir, freshState(collabId, me, sha, st.branch));
  return { sha, branch: st.branch };
}

/**
 * Move to a new base after somebody else's checkpoint: HEAD to the new base (mixed reset -- the
 * files of the worktree stay), then the state starts fresh on it.
 *
 * Safe only when everything this worktree had published is contained in the checkpoint (the
 * checkpoint was made after integrating it). Unpublished edits stay as a diff on top.
 */
export async function rebase(relay, { cwd, collabId, me, sessionId = null }) {
  const ctx = await localContext(cwd, collabId);
  const st = ctx.state;
  const cur = await codeState(relay, collabId, sessionId);
  if (!cur.code || !st) throw new Error("Nicht im Code-Modus.");
  if (cur.code.base === st.base) return { moved: false, base: st.base };
  const f = await git(ctx.top, ["fetch", "-q", "--no-tags", "origin", cur.code.branch]);
  if (f.code !== 0) throw new Error(`git fetch schlug fehl: ${f.stderr.trim()}`);
  // The WHOLE worktree -- published or not -- as a commit on top of what this worktree last knew.
  // Merged with the new base, git finds the merge base itself; what the checkpoint already contains
  // falls away, and every edit that is not in it stays. (Merging only the last PUBLISHED state lost
  // the edits made after it: review finding 2026-10-20, reproduced with read-tree.)
  const parents = [st.last || st.base, ...st.pending.filter((p) => p !== st.last)];
  const wip = await buildSnapshot(ctx.top, ctx.gitDir, { collab: collabId, base: st.base, parents, identity: { name: me } });
  const merged = await mergeTrees(ctx.top, cur.code.base, wip.head);
  // HEAD moves, the files do not (mixed reset); then the worktree moves from exactly what it holds
  // now to the merged tree. applyTree refuses if anything changed in between.
  await gitText(ctx.top, ["reset", "-q", "--mixed", cur.code.base]);
  const applied = await applyTree(ctx.top, ctx.gitDir, wip.tree, merged.tree);
  if (!applied.applied) {
    // Nothing was written; HEAD is on the new base and the files are as they were. The next call
    // tries again -- the state keeps the old base so it knows there is something to do.
    return { moved: false, base: st.base, retry: applied.reason };
  }
  const fresh = freshState(collabId, me, cur.code.base, cur.code.branch);
  if (!merged.clean) fresh.conflicts = [{ member: "checkpoint", head: cur.code.base, paths: merged.conflicts }];
  writeState(ctx.gitDir, fresh);
  return { moved: true, base: cur.code.base, carried: wip.tree !== (await gitText(ctx.top, ["rev-parse", `${cur.code.base}^{tree}`])), clean: merged.clean, conflicts: merged.conflicts };
}

/** Where everybody stands, for the status tool and the surfaces. */
export async function status(relay, { cwd, collabId, me, sessionId }) {
  const cur = await codeState(relay, collabId, sessionId);
  let local = null;
  try {
    const ctx = await localContext(cwd, collabId);
    local = ctx.state ? { base: ctx.state.base, last: ctx.state.last, conflicts: ctx.state.conflicts, integrated: ctx.state.integrated } : null;
  } catch (e) { local = { error: e.message }; }
  return {
    code: cur.code,
    me,
    local,
    members: (cur.members || []).map((m) => ({
      ...m,
      integrated: isOwnAddress(m, me, sessionId) ? null : local?.integrated?.[memberAddr(m)] === m.head,
    })),
    conflicts: cur.conflicts || [],
  };
}

/**
 * One summary line for the human at the end of a turn -- or null when nothing happened. The line
 * names numbers and people, never the mechanics.
 */
export function summaryLine(report, names = {}) {
  const who = (s) => names[s] || s;
  const parts = [];
  const integrated = report.filter((r) => r.kind === "integrated");
  if (integrated.length > 0) {
    const files = new Set(integrated.flatMap((r) => r.files));
    parts.push(`Übernommen von ${[...new Set(integrated.map((r) => who(r.member)))].join(", ")}: ${files.size} Datei${files.size === 1 ? "" : "en"}`);
  }
  for (const r of report.filter((x) => x.kind === "resolve")) {
    parts.push(`Konflikt mit ${who(r.member)} in ${r.paths.slice(0, 3).join(", ")} -- du löst ihn auf`);
  }
  for (const r of report.filter((x) => x.kind === "waiting_for_resolver")) {
    parts.push(`Konflikt mit ${who(r.member)} in ${r.paths.slice(0, 3).join(", ")} -- ${who(r.resolver)} löst ihn auf`);
  }
  for (const r of report.filter((x) => x.kind === "escalate")) {
    parts.push(`Konflikt mit ${who(r.member)} in deinem Bereich (${r.paths.slice(0, 3).join(", ")}) -- Entscheidung nötig`);
  }
  const waiting = report.filter((x) => x.kind === "waiting");
  if (waiting.length > 0) parts.push(`${waiting.length} Stand${waiting.length === 1 ? "" : "e"} wartet auf deine Freigabe`);
  if (report.some((x) => x.kind === "rebase")) parts.push("Neuer Checkpoint -- Basis wechseln");
  return parts.length > 0 ? `kwcollab: ${parts.join(". ")}.` : null;
}
