// kwcollab code exchange (WI 11517979) -- END TO END against the REAL relay.
//
// Not part of `npm test` (it needs Postgres and the litellm checkout). Run:
//   RELAY_DIR=<litellm>/relay DATABASE_URL=postgresql://... node tests/e2e/codeExchange.e2e.mjs
//
// What runs for real: relay/server.js with its schema on a real Postgres, git on real repositories
// (a bare origin + two clones), the plugin's codeExchange/codeServe code. What is faked: XID (a
// tiny userinfo server mapping a bearer to a login) and nothing else. kw/OS is never asked: the
// collab and its members are written straight into the tables, the way an accepted invitation
// leaves them.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { gitText } from "../../server/codeGit.js";
import * as flow from "../../server/codeExchange.js";
import { relayAdapter, makeFetchLive, startServing } from "../../server/codeServe.js";
import { runSseReceiver } from "../../server/sse-receiver.js";

const RELAY_DIR = process.env.RELAY_DIR;
const DATABASE_URL = process.env.DATABASE_URL;
if (!RELAY_DIR || !DATABASE_URL) { console.error("RELAY_DIR and DATABASE_URL required"); process.exit(2); }
const pg = createRequire(join(RELAY_DIR, "package.json"))("pg");

const PORT = 18090 + Math.floor(Math.random() * 500);
const XID_PORT = PORT + 1000;
const RELAY = `http://127.0.0.1:${PORT}`;
const USERS = { "tok-kai": { preferred_username: "kai", name: "Kai" }, "tok-tim": { preferred_username: "tim", name: "Tim" } };

let step = 0;
const ok = (msg) => console.log(`  ok ${++step} - ${msg}`);

// ── fake XID ──
const xid = createServer((req, res) => {
  const tok = /^Bearer (.+)$/.exec(req.headers.authorization || "")?.[1];
  const u = USERS[tok];
  res.writeHead(u ? 200 : 401, { "Content-Type": "application/json" });
  res.end(JSON.stringify(u ? { sub: u.preferred_username, ...u } : { error: "nope" }));
});
await new Promise((r) => xid.listen(XID_PORT, "127.0.0.1", r));

// ── relay ──
const relayProc = spawn(process.execPath, ["server.js"], {
  cwd: RELAY_DIR,
  env: { ...process.env, PORT: String(PORT), DATABASE_URL, XIAM_USERINFO_URL: `http://127.0.0.1:${XID_PORT}/me` },
  stdio: ["ignore", "pipe", "pipe"],
});
let relayLog = "";
relayProc.stdout.on("data", (c) => { relayLog += c; });
relayProc.stderr.on("data", (c) => { relayLog += c; });
const cleanup = [];
const finish = async (code) => {
  for (const f of cleanup.reverse()) { try { await f(); } catch { /* best effort */ } }
  relayProc.kill();
  xid.close();
  if (code !== 0) console.error(relayLog.split("\n").slice(-40).join("\n"));
  process.exit(code);
};
process.on("unhandledRejection", (e) => { console.error(e); finish(1); });

for (let i = 0; i < 100; i++) {
  try { const r = await fetch(`${RELAY}/readyz`); if (r.ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 200));
}
ok("relay up with schema");

try {
  // ── repositories: origin + two clones (Kai LF, Tim CRLF) ──
  const root = mkdtempSync(join(tmpdir(), "kwcode-e2e-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  await gitText(root, ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = join(root, "seed");
  await gitText(root, ["clone", "-q", "-c", "core.autocrlf=false", origin, seed]);
  writeFileSync(join(seed, "lib.js"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
  writeFileSync(join(seed, "README.md"), "# x\n");
  await gitText(seed, ["add", "-A"]);
  await gitText(seed, ["-c", "user.name=s", "-c", "user.email=s@x", "commit", "-q", "-m", "base"]);
  await gitText(seed, ["push", "-q", "origin", "HEAD:main"]);
  const kaiDir = join(root, "kai");
  const timDir = join(root, "tim");
  await gitText(root, ["clone", "-q", "-c", "core.autocrlf=false", origin, kaiDir]);
  await gitText(root, ["clone", "-q", "-c", "core.autocrlf=true", origin, timDir]);
  for (const d of [kaiDir, timDir]) {
    // The relay checks that the remote is the SAME repository (key) -- a local path has no key, so
    // the clones get an https remote for the key and a pushurl/url rewrite to the bare repo.
    await gitText(d, ["remote", "set-url", "origin", "https://git.example.com/team/proj.git"]);
    await gitText(d, ["config", `url.${origin.replace(/\\/g, "/")}.insteadOf`, "https://git.example.com/team/proj.git"]);
    await gitText(d, ["config", "user.name", d === kaiDir ? "Kai" : "Tim"]);
    await gitText(d, ["config", "user.email", d === kaiDir ? "kai@x" : "tim@x"]);
  }
  ok("origin + two clones (LF and CRLF)");

  // ── a collab with both joined, written the way accept leaves it ──
  const db = new pg.Pool({ connectionString: DATABASE_URL });
  cleanup.push(() => db.end());
  const sessions = { kai: "11111111-1111-4111-8111-111111111111", tim: "22222222-2222-4222-8222-222222222222" };
  // Leftovers of earlier runs would put both sessions into several channels at once.
  await db.query(`DELETE FROM relay.collab WHERE workitem IN ('11517979','11517980')`);
  for (const [who, sid] of Object.entries(sessions)) {
    await db.query(`INSERT INTO relay.session_registry (session_id, display_name, xiam_subject) VALUES ($1,$2,$3)
                    ON CONFLICT (session_id) DO NOTHING`, [sid, who, who]);
  }
  const c = await db.query(`INSERT INTO relay.collab (workitem, maintainer_subject) VALUES ('11517979','kai') RETURNING id`);
  const collab = c.rows[0].id;
  await db.query(`INSERT INTO relay.collab_member (collab_id, subject, display_name, session_id, role, status, joined_at)
                  VALUES ($1,'kai','Kai',$2,'maintainer','joined',now()), ($1,'tim','Tim',$3,'member','joined',now())`,
  [collab, sessions.kai, sessions.tim]);
  ok(`collab ${collab.slice(0, 8)} with kai (maintainer) and tim`);

  const kai = relayAdapter({ relayUrl: RELAY, getToken: async () => "tok-kai" });
  const tim = relayAdapter({ relayUrl: RELAY, getToken: async () => "tok-tim" });
  const mandate = { apply: "clean", area: [], wake: true, escalate_on: [] };

  // ── negative: tim may not switch code mode on; nobody can before it is on ──
  await assert.rejects(() => flow.start(tim, { cwd: timDir, collabId: collab, me: "tim", mandate }), /403/);
  await assert.rejects(() => flow.join(tim, { cwd: timDir, collabId: collab, me: "tim", mandate }), /noch nicht eingeschaltet/);
  ok("only the maintainer starts; join before start is refused");

  const started = await flow.start(kai, { cwd: kaiDir, collabId: collab, me: "kai", mandate });
  assert.equal(started.repo, "git.example.com/team/proj");
  await flow.join(tim, { cwd: timDir, collabId: collab, me: "tim", mandate });
  ok(`code mode on ${started.repo} ${started.branch} @ ${started.base.slice(0, 7)}, tim joined`);

  // ── 1. kai edits, publishes; tim syncs from the BUNDLE (kai not serving) ──
  writeFileSync(join(kaiDir, "lib.js"), "export const a = 10;\nexport const b = 2;\nexport const c = 3;\n");
  writeFileSync(join(kaiDir, "new.js"), "export const n = 1;\n");
  const p1 = await flow.publish(kai, { cwd: kaiDir, collabId: collab, identity: { name: "Kai" }, sessionId: sessions.kai });
  assert.equal(p1.published, true);
  const s1 = await flow.sync(tim, { cwd: timDir, collabId: collab, me: "tim", mandate, sessionId: sessions.tim });
  assert.deepEqual(s1.report.map((r) => r.kind), ["integrated"]);
  assert.equal(s1.report[0].via, "bundle");
  assert.equal(readFileSync(join(timDir, "lib.js"), "utf8"), "export const a = 10;\r\nexport const b = 2;\r\nexport const c = 3;\r\n");
  assert.equal(readFileSync(join(timDir, "new.js"), "utf8"), "export const n = 1;\r\n");
  assert.equal(flow.summaryLine(s1.report, { kai: "Kai" }), "kwcollab: Übernommen von Kai: 2 Dateien.");
  ok("kai -> tim through the bundle, CRLF on tim's side, summary line");

  // ── 2. tim edits elsewhere, kai SERVES, tim's change reaches kai LIVE ──
  const ac = new AbortController();
  cleanup.push(() => ac.abort());
  const serving = startServing({
    relayUrl: RELAY, getToken: async () => "tok-tim", collabId: collab, top: timDir, signal: ac.signal,
    runSse: (onMessage, opts) => runSseReceiver(onMessage, { ...opts, url: opts.url, getToken: async () => "tok-tim" }),
  }).catch(() => {});
  writeFileSync(join(timDir, "lib.js"), "export const a = 10;\r\nexport const b = 2;\r\nexport const c = 30;\r\n");
  const p2 = await flow.publish(tim, { cwd: timDir, collabId: collab, identity: { name: "Tim" }, sessionId: sessions.tim, serving: true });
  assert.equal(p2.published, true);
  for (let i = 0; i < 50; i++) {
    const st = await kai.get(`/v1/collabs/${collab}/code`);
    if (st.members.find((m) => m.subject === "tim")?.online) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const fetchLive = makeFetchLive({ relayUrl: RELAY, getToken: async () => "tok-kai" });
  const s2 = await flow.sync(kai, { cwd: kaiDir, collabId: collab, me: "kai", mandate, sessionId: sessions.kai, fetchLive });
  assert.deepEqual(s2.report.map((r) => `${r.kind}:${r.via || ""}`), ["integrated:live"]);
  assert.equal(readFileSync(join(kaiDir, "lib.js"), "utf8"), "export const a = 10;\nexport const b = 2;\nexport const c = 30;\n");
  ok("tim -> kai LIVE through the relay's Smart HTTP pass-through to tim's upload-pack");

  // ── negative: the pass-through serves only the out ref, and never a push ──
  const lsRemote = await fetch(`${RELAY}/v1/collabs/${collab}/git/tim/info/refs?service=git-upload-pack`, { headers: { Authorization: "Bearer tok-kai" } });
  const adv = Buffer.from(await lsRemote.arrayBuffer()).toString("latin1");
  assert.match(adv, new RegExp(`refs/kwcollab/${collab}/out`));
  assert.doesNotMatch(adv, /refs\/heads\//);
  assert.doesNotMatch(adv, /refs\/remotes\//);
  const push = await fetch(`${RELAY}/v1/collabs/${collab}/git/tim/info/refs?service=git-receive-pack`, { headers: { Authorization: "Bearer tok-kai" } });
  assert.equal(push.status, 403);
  const self = await fetch(`${RELAY}/v1/collabs/${collab}/git/kai/info/refs?service=git-upload-pack`, { headers: { Authorization: "Bearer tok-kai" } });
  assert.equal(self.status, 400);
  const stranger = await fetch(`${RELAY}/v1/collabs/${collab}/code`, { headers: { Authorization: "Bearer nope" } });
  assert.equal(stranger.status, 401);
  ok("advertisement shows only the out ref; receive-pack 403; own fetch 400; unknown bearer 401");

  // ── 3. CONFLICT: both change line c; exactly one resolves ──
  await flow.publish(kai, { cwd: kaiDir, collabId: collab, identity: { name: "Kai" }, sessionId: sessions.kai });
  await flow.sync(tim, { cwd: timDir, collabId: collab, me: "tim", mandate, sessionId: sessions.tim });
  writeFileSync(join(kaiDir, "lib.js"), "export const a = 10;\nexport const b = 2;\nexport const c = 'KAI';\n");
  await flow.publish(kai, { cwd: kaiDir, collabId: collab, identity: { name: "Kai" }, sessionId: sessions.kai });
  writeFileSync(join(timDir, "lib.js"), "export const a = 10;\r\nexport const b = 2;\r\nexport const c = 'TIM';\r\n");
  await flow.publish(tim, { cwd: timDir, collabId: collab, identity: { name: "Tim" }, sessionId: sessions.tim, serving: true });
  // Tim published later -> Tim resolves; Kai syncs first and must WAIT.
  const k3 = await flow.sync(kai, { cwd: kaiDir, collabId: collab, me: "kai", mandate, sessionId: sessions.kai, fetchLive });
  assert.deepEqual(k3.report.map((r) => r.kind), ["waiting_for_resolver"]);
  assert.equal(k3.report[0].resolver, "tim");
  assert.equal(readFileSync(join(kaiDir, "lib.js"), "utf8"), "export const a = 10;\nexport const b = 2;\nexport const c = 'KAI';\n", "kai's file untouched");
  const t3 = await flow.sync(tim, { cwd: timDir, collabId: collab, me: "tim", mandate, sessionId: sessions.tim });
  assert.deepEqual(t3.report.map((r) => r.kind), ["resolve"]);
  assert.match(readFileSync(join(timDir, "lib.js"), "utf8"), /^<<<<<<< /m);
  await assert.rejects(() => flow.resolved(tim, { cwd: timDir, collabId: collab, identity: { name: "Tim" }, sessionId: sessions.tim }), /Konfliktmarker/);
  writeFileSync(join(timDir, "lib.js"), "export const a = 10;\r\nexport const b = 2;\r\nexport const c = 'KAI+TIM';\r\n");
  const r3 = await flow.resolved(tim, { cwd: timDir, collabId: collab, identity: { name: "Tim" }, sessionId: sessions.tim });
  assert.deepEqual(r3.resolved, ["kai"]);
  const state3 = await kai.get(`/v1/collabs/${collab}/code`);
  assert.deepEqual(state3.conflicts, [], "the relay closed the conflict");
  const k3b = await flow.sync(kai, { cwd: kaiDir, collabId: collab, me: "kai", mandate, sessionId: sessions.kai });
  assert.deepEqual(k3b.report.map((r) => r.kind), ["integrated"]);
  assert.equal(readFileSync(join(kaiDir, "lib.js"), "utf8"), "export const a = 10;\nexport const b = 2;\nexport const c = 'KAI+TIM';\n");
  ok("conflict: tim (later) resolves, kai waits untouched, markers refused, resolution integrates clean");

  // ── negative: a secret in the diff blocks the publish ──
  writeFileSync(join(kaiDir, "cfg.js"), `export const key = "sk-${"q".repeat(32)}";\n`);
  await assert.rejects(() => flow.publish(kai, { cwd: kaiDir, collabId: collab, identity: { name: "Kai" }, sessionId: sessions.kai }), /Zugangsdaten in cfg\.js:1/);
  rmSync(join(kaiDir, "cfg.js"));
  ok("credential in the diff blocks the publish, names file and line");

  // ── 4. CHECKPOINT by kai; tim moves to the new base ──
  await flow.publish(kai, { cwd: kaiDir, collabId: collab, identity: { name: "Kai" }, sessionId: sessions.kai });
  await flow.sync(tim, { cwd: timDir, collabId: collab, me: "tim", mandate, sessionId: sessions.tim });
  await flow.publish(tim, { cwd: timDir, collabId: collab, identity: { name: "Tim" }, sessionId: sessions.tim });
  const cp = await flow.checkpoint(kai, {
    cwd: kaiDir, collabId: collab, me: "kai", mandate, message: "feat: shared work (#11517979)",
    coAuthors: ["Tim <tim@x>"], sessionId: sessions.kai,
  });
  assert.equal(await gitText(seed, ["ls-remote", origin, "refs/heads/main"]).then((s) => s.split("\t")[0]), cp.sha);
  const msg = await gitText(kaiDir, ["log", "-1", "--format=%B"]);
  assert.match(msg, /Co-authored-by: Tim <tim@x>/);
  const files = (await gitText(kaiDir, ["show", "--name-only", "--format=", cp.sha])).split("\n").sort();
  assert.deepEqual(files, ["lib.js", "new.js"]);
  const after = await kai.get(`/v1/collabs/${collab}/code`);
  assert.equal(after.code.base, cp.sha);
  assert.equal(after.bundles.length, 0, "bundles of the old base are gone");
  const t4 = await flow.sync(tim, { cwd: timDir, collabId: collab, me: "tim", mandate, sessionId: sessions.tim });
  assert.equal(t4.rebase, true);
  const rb = await flow.rebase(tim, { cwd: timDir, collabId: collab, me: "tim" });
  assert.equal(rb.moved, true);
  assert.equal(await gitText(timDir, ["rev-parse", "HEAD"]), cp.sha);
  assert.equal(await gitText(timDir, ["status", "--porcelain"]), "", "tim's worktree equals the checkpoint");
  ok(`checkpoint ${cp.sha.slice(0, 7)} pushed with co-author, base moved, tim rebased clean`);

  // ── negative: a bundle not on the base is refused by the relay ──
  const bad = await fetch(`${RELAY}/v1/collabs/${collab}/code/bundles`, {
    method: "POST",
    headers: { Authorization: "Bearer tok-tim", "Content-Type": "application/x-git-bundle", "X-Kwcollab-Head": "a".repeat(40), "X-Kwcollab-Prereqs": started.base },
    body: Buffer.from("# v2 git bundle\n"),
  });
  assert.equal(bad.status, 409);
  ok("bundle on the old base refused (409)");

  // ── channel: code lines are readable chat lines for old plugins and do not pause it ──
  const msgs = await db.query(`SELECT kind, author_kind, text FROM relay.collab_message WHERE collab_id=$1 AND kind='code' ORDER BY seq`, [collab]);
  assert.ok(msgs.rows.length >= 10);
  assert.ok(msgs.rows.every((r) => r.author_kind === "claude" && r.text.startsWith("code ")));
  const col = await db.query(`SELECT claude_streak, paused FROM relay.collab WHERE id=$1`, [collab]);
  assert.equal(col.rows[0].paused, false);
  assert.equal(col.rows[0].claude_streak, 0);
  ok(`${msgs.rows.length} code lines in the channel, streak untouched, not paused`);

  // ── close deletes everything ──
  ac.abort();
  await serving;
  await fetch(`${RELAY}/v1/collabs/${collab}/close`, {
    method: "POST", headers: { Authorization: "Bearer tok-kai", "Content-Type": "application/json" }, body: JSON.stringify({ summary: "done" }),
  });
  const left = await db.query(`SELECT (SELECT count(*) FROM relay.collab_bundle WHERE collab_id=$1) b,
                                      (SELECT count(*) FROM relay.collab_message WHERE collab_id=$1) m,
                                      (SELECT code_mode FROM relay.collab WHERE id=$1) cm`, [collab]);
  assert.deepEqual(left.rows[0], { b: "0", m: "0", cm: false });
  ok("close removed bundles and lines, code mode off");

  // ── 5. the SESSION path: tools in an MCP-server process, the Stop hook, the monitor's serving ──
  // Each runs as its own node process with the env a kwclaude session gives it -- the same entry
  // points Claude Code starts. Tim works through these; Kai stays on the flow API.
  const PLUGIN = new URL("../../", import.meta.url);
  const sessionEnv = (who, cwd) => ({
    ...process.env,
    KWOS_RELAY_URL: RELAY, KWOS_XID_ACCESS_TOKEN: `tok-${who}`, CLAUDE_CODE_SESSION_ID: sessions[who],
    KWOS_COLLAB_CANARY: "1", KWOS_CLIENT_ID: "", PWD: cwd,
  });
  const runNode = (who, cwd, args, input = "") => new Promise((resolve) => {
    const p = spawn(process.execPath, args, { cwd, env: sessionEnv(who, cwd), stdio: ["pipe", "pipe", "pipe"] });
    let out = ""; let err = "";
    p.stdout.on("data", (c) => { out += c; }); p.stderr.on("data", (c) => { err += c; });
    p.on("close", (code) => resolve({ code, out, err }));
    p.stdin.end(input);
  });
  const tool = async (who, cwd, name, args = {}) => {
    const script = `const {handleToolCall}=await import(${JSON.stringify(new URL("server/index.js", PLUGIN).href)});` +
      // No process.exit(): on Windows an exit while a keep-alive socket is closing trips a libuv
      // assert (measured). The tool call's own handles are unref'd; the process ends by itself.
      `const r=await handleToolCall(${JSON.stringify(name)},${JSON.stringify(args)});process.stdout.write(r.content[0].text);process.exitCode=0;setTimeout(()=>process.exit(0),1500).unref();`;
    const r = await runNode(who, cwd, ["--input-type=module", "-e", script]);
    if (r.code !== 0) throw new Error(`${name}: ${r.err.slice(-600)}`);
    return r.out;
  };
  const hook = async (who, cwd, mode, payload) => {
    const r = await runNode(who, cwd, [fileURLToPath(new URL("hooks/code-hook.js", PLUGIN)), mode], JSON.stringify({ cwd, ...payload }));
    assert.equal(r.code, 0, `hook ${mode} exit: ${r.err.slice(-400)}`);
    return r.out ? JSON.parse(r.out) : null;
  };

  // A fresh collab on the checkpoint base, both joined again.
  const c2 = await db.query(`INSERT INTO relay.collab (workitem, maintainer_subject) VALUES ('11517980','kai') RETURNING id`);
  const collab2 = c2.rows[0].id;
  await db.query(`INSERT INTO relay.collab_member (collab_id, subject, display_name, session_id, role, status, joined_at)
                  VALUES ($1,'kai','Kai',$2,'maintainer','joined',now()), ($1,'tim','Tim',$3,'member','joined',now())`,
  [collab2, sessions.kai, sessions.tim]);
  for (const d of [kaiDir, timDir]) rmSync(join(await gitText(d, ["rev-parse", "--absolute-git-dir"]), "kwcollab"), { recursive: true, force: true });
  await flow.start(kai, { cwd: kaiDir, collabId: collab2, me: "kai", mandate });
  const joinOut = await tool("tim", timDir, "collab_code_join", { mandate: { apply: "clean" } });
  assert.match(joinOut, /Beigetreten/);
  ok("collab_code_join as a real tool call in its own process");

  // Off-mode sessions pay nothing: a hook in a repo without code mode prints nothing.
  assert.equal(await hook("tim", seed, "stop", { hook_event_name: "Stop" }), null);

  // Tim edits; the STOP HOOK publishes. Kai's edit precheck on that file is then refused.
  writeFileSync(join(timDir, "README.md"), "# x\r\nfrom tim\r\n");
  const stop1 = await hook("tim", timDir, "stop", { hook_event_name: "Stop" });
  assert.equal(stop1, null, "nothing to report on tim's side: only his own publish");
  const preKai = await (async () => {
    const r = await runNode("kai", kaiDir, [fileURLToPath(new URL("hooks/code-hook.js", PLUGIN)), "pretooluse"],
      JSON.stringify({ cwd: kaiDir, tool_name: "Edit", tool_input: { file_path: join(kaiDir, "README.md") } }));
    return r.out ? JSON.parse(r.out) : null;
  })();
  assert.equal(preKai?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(preKai.hookSpecificOutput.permissionDecisionReason, /Tim hat README\.md/);
  const preOther = await runNode("kai", kaiDir, [fileURLToPath(new URL("hooks/code-hook.js", PLUGIN)), "pretooluse"],
    JSON.stringify({ cwd: kaiDir, tool_name: "Edit", tool_input: { file_path: join(kaiDir, "lib.js") } }));
  assert.equal(preOther.out, "", "an unrelated file is not held");
  ok("Stop hook published tim's edit; kai's Edit on README.md is held by the precheck, lib.js is not");

  // Kai's Stop hook takes it in and says so in ONE line; then the precheck lets the edit through.
  const stopKai = await hook("kai", kaiDir, "stop", { hook_event_name: "Stop" });
  assert.equal(stopKai?.systemMessage, "kwcollab: Übernommen von Tim: 1 Datei.");
  assert.equal(readFileSync(join(kaiDir, "README.md"), "utf8"), "# x\nfrom tim\n");
  const preAfter = await runNode("kai", kaiDir, [fileURLToPath(new URL("hooks/code-hook.js", PLUGIN)), "pretooluse"],
    JSON.stringify({ cwd: kaiDir, tool_name: "Write", tool_input: { file_path: join(kaiDir, "README.md") } }));
  assert.equal(preAfter.out, "");
  ok(`Stop hook on kai's side: "${stopKai.systemMessage}"; the edit is free afterwards`);

  // Tim's MONITOR, the real entry point (server/monitor.js) in its own process: it finds the channel
  // by polling, sees the worktree in code mode and opens the back channel. Kai's next sync is LIVE.
  const monitor = spawn(process.execPath, [fileURLToPath(new URL("server/monitor.js", PLUGIN))], {
    cwd: timDir, env: { ...sessionEnv("tim", timDir), KWOS_COLLAB_POLL_MS: "500" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let monitorOut = "";
  monitor.stdout.on("data", (c) => { monitorOut += c; });
  cleanup.push(() => monitor.kill());
  let online = false;
  for (let i = 0; i < 100 && !online; i++) {
    const st = await kai.get(`/v1/collabs/${collab2}/code`);
    online = Boolean(st.members.find((m) => m.subject === "tim")?.online);
    if (!online) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(online, "tim's monitor serves");
  writeFileSync(join(timDir, "lib.js"), "export const a = 10;\r\nexport const b = 'TIM';\r\nexport const c = 'KAI+TIM';\r\n");
  await hook("tim", timDir, "stop", { hook_event_name: "Stop" });
  const live = await flow.sync(kai, { cwd: kaiDir, collabId: collab2, me: "kai", mandate, sessionId: sessions.kai, fetchLive });
  assert.deepEqual(live.report.map((r) => `${r.kind}:${r.via}`), ["integrated:live"]);
  // And the monitor printed kai's integration as a channel line into tim's session (wake = true).
  for (let i = 0; i < 40 && !/code integrated/.test(monitorOut); i++) await new Promise((r) => setTimeout(r, 250));
  // The head carries the message's seq since WI 11536314 ("[kwcollab <short>:<seq> | ...]").
  assert.match(monitorOut, /\[kwcollab [0-9a-f]{8}:\d+ \| Kai \| claude\] code integrated/);
  ok("tim's monitor process served kai's live fetch and showed kai's integration as a channel line");
  monitor.kill();

  // ── 6. a question to the people, the human answer, and the memory the gateway derives ──
  const esc = await tool("tim", timDir, "collab_code_escalate", { topic: "Bleibt das Feld b?", options: ["behalten", "entfernen"], recommend: 0, paths: ["lib.js"] });
  assert.match(esc, /vorgelegt/);
  const open = await kai.get(`/v1/collabs/${collab2}/code`);
  assert.equal(open.questions.length, 1, "the question is open");
  const stopQ = await hook("kai", kaiDir, "stop", { hook_event_name: "Stop" });
  assert.match(stopQ?.systemMessage ?? "", /Entscheidung nötig, gestellt von Tim: Bleibt das Feld b\? \(1\) behalten \[empfohlen\] \(2\) entfernen/);
  await fetch(`${RELAY}/v1/collabs/${collab2}/messages`, {
    method: "POST", headers: { Authorization: "Bearer tok-kai", "Content-Type": "application/json" },
    body: JSON.stringify({ text: "behalten", author_kind: "human", session_id: sessions.kai }),
  });
  const answered = await kai.get(`/v1/collabs/${collab2}/code`);
  assert.equal(answered.questions.length, 0, "a human line answered it");
  // The memory: spec from kw/OS is NOT reachable here (no kw/OS in this test) -- the route must say
  // so instead of failing, and still hand out the decision.
  const mem = await tim.get(`/v1/collabs/${collab2}/code/memory`);
  assert.deepEqual(mem.decisions.map((d) => `${d.question}|${d.answer}|${d.answered_by}`), ["Bleibt das Feld b?|behalten|Kai"]);
  assert.equal(mem.spec, null);
  assert.ok(mem.spec_error);
  const memTool = await tool("tim", timDir, "collab_code_memory");
  assert.match(memTool, /- Bleibt das Feld b\? -> behalten \(Kai\)/);
  ok("escalate -> open question in every Stop hook -> human answer closes it -> decision in the gateway's memory");

  console.log(`\nall ${step} steps passed`);
  await finish(0);
} catch (e) {
  console.error("FAILED at step", step + 1, e);
  await finish(1);
}
