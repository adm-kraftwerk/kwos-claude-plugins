import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

// The HOOK as a process (WI 11569154): it stands in front of a tool call, so the only two things
// that matter here are that it never says anything while it is unsure and that it never costs the
// caller more than its budget.

const HOOK = fileURLToPath(new URL("../hooks/teams-guard.js", import.meta.url));
const PAYLOAD = JSON.stringify({ session_id: "sess-hook-test", tool_name: "mcp__ms365__send-chat-message" });

/** A relay socket that ACCEPTS and then says nothing -- the case a plain timeout does not cover. */
async function hangingRelay() {
  const server = createServer(() => { /* accept, never answer */ });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  // NOT awaited on close: the accepted socket of the hook may outlive the test by a moment, and
  // `server.close(cb)` waits for every connection to end -- awaiting it would hang the suite on
  // the very socket this test exists to leave hanging.
  return { url: `http://127.0.0.1:${port}`, close: () => { server.close(); server.unref(); } };
}

function runHook(event, { relayUrl, token = "" }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [HOOK, event], {
      env: {
        ...process.env,
        KWOS_RELAY_URL: relayUrl,
        // The helper is the fallback path; a token in the environment is what makes the request
        // actually happen (`auth.js` returns `config.tokenOverride` first).
        KWOS_XID_TOKEN_HELPER_PATH: "/nonexistent/xiam-token",
        KWOS_XID_ACCESS_TOKEN: token,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(kill);
      resolve({ code, out, ms: Date.now() - started });
    };
    // stderr is DRAINED, not ignored: a full pipe would block the child, and the test would then
    // measure its own harness instead of the hook.
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.on("close", (code) => finish(code));
    child.on("error", () => finish(-1));
    // A hook that never returns is the failure this test exists for: kill it and let the
    // assertion say so instead of hanging the suite.
    const kill = setTimeout(() => {
      child.kill("SIGKILL");
      finish(-9);
    }, 8_000);
    child.stdin.end(PAYLOAD);
  });
}

test("a relay that accepts and never answers costs the send its budget, not the hook timeout", async () => {
  const relay = await hangingRelay();
  try {
    // WITH a token: without one the helper fails first and the request never happens -- the
    // budget would then look fine while never having been tested.
    const r = await runHook("pretooluse", { relayUrl: relay.url, token: "test-token" });
    assert.equal(r.code, 0, "der Hook darf den Aufruf nie scheitern lassen");
    assert.equal(r.out, "", "ohne Antwort kein Hinweis");
    // The budget (1.5 s) plus Node start plus slack -- and far below the 5 s hook timeout.
    assert.ok(r.ms < 4_000, `Hook brauchte ${r.ms} ms`);
    assert.ok(r.ms >= 1_000, `der Budgetfall wurde nicht ausgeloest (${r.ms} ms) -- kein Token?`);
  } finally {
    relay.close();
  }
});

test("a relay that is not there at all is quiet too", async () => {
  const r = await runHook("pretooluse", { relayUrl: "http://127.0.0.1:1" });
  assert.equal(r.code, 0);
  assert.equal(r.out, "");
});

test("an event this hook does not own says nothing -- and does not touch the relay", async () => {
  const relay = await hangingRelay();
  try {
    // `userpromptsubmit` is not this hook's job; with the network hanging it must still return at
    // once, which is only possible if it never asks.
    const r = await runHook("userpromptsubmit", { relayUrl: relay.url });
    assert.equal(r.code, 0);
    assert.equal(r.out, "");
    assert.ok(r.ms < 2_000, `Hook brauchte ${r.ms} ms -- er hat den Relay gefragt`);
  } finally {
    relay.close();
  }
});
