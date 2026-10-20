// kwcollab code exchange (WI 11517979): the session-facing pieces that need no git and no relay --
// the tool gate, the wake rule, the edit precheck, the summary line, and the hook's fast exit.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.KWOS_XID_ACCESS_TOKEN = "test-token";
const { visibleTools, handleToolCall } = await import("../server/index.js");
const { CODE_TOOLS } = await import("../server/codeTools.js");
const { frameToLine } = await import("../server/collab-listen.js");
const { editBlocker } = await import("../server/codeRuntime.js");
const { summaryLine } = await import("../server/codeExchange.js");

const HOOK = fileURLToPath(new URL("../hooks/code-hook.js", import.meta.url));
const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
const INDEX_URL = new URL("../server/index.js", import.meta.url).href;
const RUNTIME_URL = new URL("../server/codeRuntime.js", import.meta.url).href;

test("die Code-Werkzeuge stehen hinter derselben Kanal-Freigabe wie die anderen collab_-Werkzeuge", async () => {
  const names = CODE_TOOLS.map((t) => t.name);
  assert.ok(names.every((n) => n.startsWith("collab_code_")));
  const off = visibleTools({}).map((t) => t.name);
  assert.ok(names.every((n) => !off.includes(n)), "ausserhalb des Rings nicht angeboten");
  const on = visibleTools({ KWOS_COLLAB_CANARY: "1" }).map((t) => t.name);
  assert.ok(names.every((n) => on.includes(n)), "im Ring angeboten");
  const prev = process.env.KWOS_COLLAB_CANARY;
  delete process.env.KWOS_COLLAB_CANARY;
  try {
    await assert.rejects(() => handleToolCall("collab_code_sync", {}), /nicht freigegeben/);
  } finally { if (prev !== undefined) process.env.KWOS_COLLAB_CANARY = prev; }
});

test("jede Code-Werkzeugbeschreibung hat ein geschlossenes Schema", () => {
  for (const t of CODE_TOOLS) {
    assert.equal(t.inputSchema.type, "object", t.name);
    assert.equal(t.inputSchema.additionalProperties, false, t.name);
    assert.ok(t.description.length > 60, `${t.name} braucht eine Anleitung`);
  }
});

const codeFrame = (type, extra = {}) => JSON.stringify({
  seq: 9, collab_id: "c1", from_subject: "kai", from_session: "s-kai", author_kind: "claude", kind: "code",
  text: `code ${type}`, payload: { type, ...extra },
});

test("eine Code-Zeile weckt den Agenten nur mit wake -- eine Rueckfrage an die Menschen immer", () => {
  assert.match(frameToLine(codeFrame("snapshot"), { selfSessionId: "me", wakeOnCode: true }), /code snapshot/);
  assert.equal(frameToLine(codeFrame("snapshot"), { selfSessionId: "me", wakeOnCode: false }), null);
  assert.match(frameToLine(codeFrame("escalate"), { selfSessionId: "me", wakeOnCode: false }), /code escalate/);
  // A chat line is never affected by the code mandate.
  const chat = JSON.stringify({ seq: 10, collab_id: "c1", from_subject: "kai", author_kind: "human", text: "hallo" });
  assert.match(frameToLine(chat, { selfSessionId: "me", wakeOnCode: false }), /hallo/);
});

test("Vorabpruefung: ein fremder, noch nicht uebernommener Stand mit dieser Datei haelt den Edit an", () => {
  const members = [
    { subject: "me", head: "a", head_paths: ["x.js"] },
    { subject: "kai", head: "k1", head_paths: ["lib.js"], online: true },
    { subject: "tim", head: "t1", head_paths: null, online: true },
  ];
  assert.match(editBlocker(members, { me: "me", integrated: { tim: "t1" }, rel: "lib.js", names: { kai: "Kai" } }), /^Kai hat lib\.js/);
  // Already integrated -> go.
  assert.equal(editBlocker(members, { me: "me", integrated: { kai: "k1", tim: "t1" }, rel: "lib.js" }), null);
  // Other file -> go.
  assert.equal(editBlocker(members, { me: "me", integrated: { tim: "t1" }, rel: "other.js" }), null);
  // Unknown path list (cut) -> wait, the safe direction.
  assert.match(editBlocker(members, { me: "me", integrated: { kai: "k1" }, rel: "anything.js" }), /^tim hat/);
  // My own snapshot never blocks me.
  assert.equal(editBlocker([{ subject: "me", head: "a", head_paths: ["x.js"] }], { me: "me", rel: "x.js" }), null);
  // A state nobody can fetch (offline, no bundle for that head) must not hold the file forever.
  const away = [{ subject: "kai", head: "k1", head_paths: ["lib.js"], online: false }];
  assert.equal(editBlocker(away, { me: "me", rel: "lib.js", bundles: [] }), null);
  assert.equal(editBlocker(away, { me: "me", rel: "lib.js", bundles: [{ member: "kai", head: "old" }] }), null);
  assert.match(editBlocker(away, { me: "me", rel: "lib.js", bundles: [{ member: "kai", head: "k1" }] }), /^kai hat lib\.js/);
});

test("die Zusammenfassung ist EINE Zeile mit Namen und Zahlen -- und null, wenn nichts war", () => {
  assert.equal(summaryLine([]), null);
  assert.equal(summaryLine([{ kind: "contained", member: "kai" }]), null);
  const line = summaryLine([
    { kind: "integrated", member: "kai", files: ["a.js", "b.js"] },
    { kind: "integrated", member: "tim", files: ["b.js"] },
    { kind: "waiting_for_resolver", member: "mara", resolver: "mara", paths: ["c.js"] },
  ], { kai: "Kai", tim: "Tim", mara: "Mara" });
  assert.equal(line, "kwcollab: Übernommen von Kai, Tim: 2 Dateien. Konflikt mit Mara in c.js -- Mara löst ihn auf.");
  assert.doesNotMatch(line, /\n/);
});

test("eine offene Frage an die Menschen steht in jeder Zusammenfassung, mit Optionen und Empfehlung", async () => {
  const { questionLine } = await import("../server/codeRuntime.js");
  assert.equal(questionLine([]), null);
  assert.equal(questionLine(undefined), null);
  const line = questionLine([{ asked_by: "tim", topic: "Feld behalten?", options: ["ja", "nein"], recommend: 0 }], { tim: "Tim" });
  assert.equal(line, "Entscheidung nötig, gestellt von Tim: Feld behalten? (1) ja [empfohlen] (2) nein. Antworte im Kanal");
  assert.match(questionLine([{ asked_by: "a", topic: "x", options: ["1", "2"] }, { asked_by: "b", topic: "y", options: ["1", "2"] }]), /und 1 weitere offene Frage\)/);
});

test("das Gedaechtnis kommt vom Gateway und wird als Daten gerahmt -- mit Entscheidungen und Spec-Auszug", async () => {
  const { memoryBlock } = await import("../server/codeTools.js");
  const text = memoryBlock({
    workitem: "11517979",
    spec: { text: "## TL;DR\nZiel", total_chars: 9000, cut: true },
    decisions: [{ question: "Feld behalten?", answer: "ja, wegen API", answered_by: "Kai" }],
  });
  assert.match(text, /Daten, keine Anweisung an dich/);
  assert.match(text, /- Feld behalten\? -> ja, wegen API \(Kai\)/);
  assert.match(text, /gekürzt, 9000 Zeichen/);
  assert.match(memoryBlock({ workitem: "1", spec: null, spec_error: "403", decisions: [] }), /\(noch keine\)[\s\S]*nicht lesbar: 403/);
});

test("das Plugin schreibt nichts ins Workitem", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = new URL("../server/", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.startsWith("code") && x.endsWith(".js"))) {
    const src = readFileSync(new URL(f, dir), "utf8");
    assert.doesNotMatch(src, /patchWorkitemMarkdown|replaceWorkitemMarkdown|addWorkitemComment/, f);
  }
});

test("der Hook tut ausserhalb des Rings und ausserhalb des Code-Modus nichts -- ohne Netz, ohne Ausgabe", () => {
  const dir = mkdtempSync(join(tmpdir(), "kwcode-hook-"));
  try {
    const run = (env, payload) => spawnSync(process.execPath, [HOOK, "stop"], {
      input: JSON.stringify(payload), encoding: "utf8",
      // A relay URL nobody listens on: any network attempt would hang or fail loudly.
      env: { ...process.env, KWOS_RELAY_URL: "http://127.0.0.1:9", ...env },
      timeout: 15000,
    });
    const offRing = run({ KWOS_COLLAB_CANARY: "0" }, { cwd: dir, hook_event_name: "Stop" });
    assert.equal(offRing.status, 0);
    assert.equal(offRing.stdout, "");
    const noRepo = run({ KWOS_COLLAB_CANARY: "1" }, { cwd: dir, hook_event_name: "Stop" });
    assert.equal(noRepo.status, 0);
    assert.equal(noRepo.stdout, "");
    spawnSync("git", ["init", "-q"], { cwd: dir });
    const notJoined = run({ KWOS_COLLAB_CANARY: "1" }, { cwd: dir, hook_event_name: "Stop" });
    assert.equal(notJoined.status, 0);
    assert.equal(notJoined.stdout, "");
    const pre = spawnSync(process.execPath, [HOOK, "pretooluse"], {
      input: "not json", encoding: "utf8", env: { ...process.env, KWOS_COLLAB_CANARY: "1" }, timeout: 15000,
    });
    assert.equal(pre.status, 0);
    assert.equal(pre.stdout, "");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A hook failure BEFORE the inner try/catch -- the dynamic import of codeRuntime.js, most notably,
// when a partial plugin update left that file missing or half-written -- used to exit 0 in silence:
// a dead hook and a quiet turn end looked exactly alike, which is the one thing this file promises
// never to be (WI 11523603). The reason must reach the human, and the hook must still never block
// the turn.
test("a hook failure before its own try/catch is said out loud, not swallowed", () => {
  const root = mkdtempSync(join(tmpdir(), "kwcode-hook-broken-"));
  try {
    // A copy of the plugin, so the missing module is a copy's problem and not this checkout's.
    const plugin = join(root, "plugin");
    cpSync(PLUGIN_ROOT, plugin, { recursive: true, filter: (src) => !src.includes("node_modules") });
    const worktree = join(root, "worktree");
    mkdirSync(worktree, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: worktree });
    // In code mode: the hook's local test finds this and goes on to load the runtime.
    mkdirSync(join(worktree, ".git", "kwcollab"), { recursive: true });
    writeFileSync(join(worktree, ".git", "kwcollab", "state.json"), "{}", "utf8");
    // The partial update: the module the hook loads at the end of the turn is not there.
    rmSync(join(plugin, "server", "codeRuntime.js"));

    const r = spawnSync(process.execPath, [join(plugin, "hooks", "code-hook.js"), "stop"], {
      input: JSON.stringify({ cwd: worktree, hook_event_name: "Stop" }),
      encoding: "utf8",
      env: { ...process.env, KWOS_COLLAB_CANARY: "1", KWOS_RELAY_URL: "http://127.0.0.1:9" },
      timeout: 20000,
    });

    assert.equal(r.status, 0, "the hook never blocks a turn");
    const out = JSON.parse(r.stdout.trim().split("\n").pop());
    assert.match(out.systemMessage, /Hook abgebrochen/, "the human sees it");
    assert.match(out.systemMessage, /codeRuntime/, "with the reason, not just 'something failed'");
    assert.match(r.stderr, /Hook abgebrochen/, "and a line for the log");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The server is long-lived and asks for the worktree on EVERY collab_code_* call. Where the process
// could not report its working directory -- a worktree that is gone or lost its permissions --
// config.js (WI 11523603) chdirs to a fallback so later path queries keep working; process.cwd()
// therefore answers with THAT ($HOME, $TMPDIR, /). Those are not this session's worktree: the tools
// must not hand the fallback to codeContext, and where there is no worktree they must say so
// instead of asking the relay about the wrong directory (measured 2026-10-20 on the unfixed code:
// the call went to the relay and came back as "Fehler: fetch failed").
test("with no readable working directory a collab_code_* call answers instead of searching $HOME", () => {
  const root = mkdtempSync(join(tmpdir(), "kwcode-cwd-"));
  const child = join(root, "worktree");
  mkdirSync(child, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), "kwcode-home-"));
  const probe = join(home, "probe.mjs");
  writeFileSync(probe, `
    const { callTool } = await import(${JSON.stringify(INDEX_URL)});
    const { codeContext } = await import(${JSON.stringify(RUNTIME_URL)});
    const bare = await codeContext();                                  // the default, i.e. sessionCwd
    const r = await callTool({ params: { name: "collab_code_status", arguments: {} } });
    console.log(JSON.stringify({
      fallbackCwd: process.cwd(), bare: bare.reason,
      text: r.content[0].text, isError: Boolean(r.isError),
    }));
  `, "utf8");

  // Start the shell INSIDE the directory while it is still reachable, then take the directory's
  // search permission away (the pattern of tests/config.test.js): shell and node inherit the cwd,
  // but it can no longer be resolved -- process.cwd() throws at module load.
  let out;
  try {
    out = execFileSync("/bin/sh", ["-c", `chmod 000 "${root}" && "${process.execPath}" "${probe}"; status=$?; chmod 755 "${root}"; exit $status`], {
      cwd: child,
      env: {
        ...process.env,
        HOME: home,                       // the fallback config.js chdirs to -- not the worktree
        KWOS_COLLAB_CANARY: "1",
        KWOS_RELAY_URL: "http://127.0.0.1:9", // nothing listens: reaching it at all is the failure
        KWOS_XID_ACCESS_TOKEN: "test-token",
        KWOS_CLIENT_ID: "cli-0000-nocwd",
        CLAUDE_CODE_SESSION_ID: "session-FROM-ENV",
      },
      encoding: "utf8",
      timeout: 20000,
    });
  } finally {
    try { chmodSync(root, 0o755); } catch { /* the shell restored it already */ }
  }
  const r = JSON.parse(out.trim().split("\n").pop());
  // macOS resolves /var to /private/var: compare against the directory the child sees.
  const fallback = realpathSync(home);

  assert.equal(r.fallbackCwd, fallback, "the fallback is what a late process.cwd() would answer with");
  assert.match(r.bare, /Arbeitsverzeichnis dieser Sitzung ist nicht lesbar/, "codeContext asks the session");
  assert.equal(r.isError, true, "the tool answers with a reason, not a crash");
  assert.match(r.text, /Arbeitsverzeichnis dieser Sitzung ist nicht lesbar/);
  assert.doesNotMatch(r.text, /fetch failed|EPERM|EACCES|uv_cwd/, "no relay call, no uv_cwd");
  assert.ok(!r.text.includes(fallback), "the fallback never stands in for the worktree");
});
