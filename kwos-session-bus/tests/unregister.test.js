import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { installFetchMock } from "./helpers/fetch-mock.js";

// KWOS_XID_ACCESS_TOKEN vor dem Import von config.js setzen (s. relay-client.test.js): der Override
// wird beim Modul-Import aus process.env gelesen, deshalb dynamischer Import in Programmreihenfolge.
process.env.KWOS_XID_ACCESS_TOKEN = "test-token";
const { config } = await import("../server/config.js");
const relay = await import("../server/relay-client.js");

const noJson = { get: () => null };

test("unregister: POST /v1/sessions/<self>/unregister mit Bearer-Token und ohne Body", async () => {
  config.sessionId = "sess-unreg";
  const mock = installFetchMock(() =>
    Promise.resolve({ ok: true, status: 200, headers: noJson, json: async () => ({}) })
  );
  try {
    await relay.unregister();
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].url, "https://llm.os.kraftwerk.io/v1/sessions/sess-unreg/unregister");
    assert.equal(mock.calls[0].init.method, "POST");
    assert.equal(mock.calls[0].init.headers.Authorization, "Bearer test-token");
    assert.equal(mock.calls[0].init.body, undefined);
  } finally {
    mock.restore();
  }
});

test("unregister: Fehlerantwort wird nicht wiederholt und als Fehler gemeldet", async () => {
  config.sessionId = "sess-unreg";
  const mock = installFetchMock(() =>
    Promise.resolve({ ok: false, status: 500, headers: noJson, text: async () => "boom" })
  );
  try {
    await assert.rejects(() => relay.unregister(), /500/);
    assert.equal(mock.calls.length, 1, "ein Fehlschlag darf keinen zweiten Versuch ausloesen");
  } finally {
    mock.restore();
  }
});

test("unregister: haengender Relay haelt den Prozess nicht ueber die Frist hinaus", async () => {
  config.sessionId = "sess-unreg";
  const mock = installFetchMock(() => new Promise(() => {}));
  const started = Date.now();
  try {
    await assert.rejects(() => relay.unregister({ timeoutMs: 100 }), /keine Antwort in 100 ms/);
    assert.ok(Date.now() - started < 1000, "die Abmeldung muss innerhalb der Frist aufgeben");
  } finally {
    mock.restore();
  }
});

// ── Der Signalweg (WI 11600377) ───────────────────────────────────────────────
//
// Geprueft wird die ECHTE Einstiegsdatei aus monitors/monitors.json, als Prozess, gegen einen
// Relay-Ersatz -- nicht ein nachgebautes Modul. Nur so ist belegt, dass der Prozess, den die
// Sitzung tatsaechlich bekommt, beim Beenden abmeldet und danach endet.

const root = fileURLToPath(new URL("..", import.meta.url));
const SESSION = "sess-signal";

/** Ein Relay-Ersatz: beantwortet alles mit 200 und merkt sich die Abmeldung. */
function startFakeRelay() {
  const requests = [];
  let solve;
  const unregistered = new Promise((resolve) => { solve = resolve; });
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    if (req.url.endsWith("/events")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": offen\n\n");
      return;
    }
    if (req.method === "POST" && req.url.endsWith(`/sessions/${SESSION}/unregister`)) {
      solve({ url: req.url, authorization: req.headers.authorization });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.url === "/v1/collabs" ? JSON.stringify({ collabs: [] }) : "{}");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        unregistered,
        close: () => new Promise((r) => {
          server.closeAllConnections?.();
          server.close(() => r());
        }),
      });
    });
  });
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Bedingung nicht erfuellt nach ${timeoutMs} ms`);
}

async function startMonitor(relayUrl) {
  const child = spawn(process.execPath, [`${root}server/monitor.js`], {
    cwd: tmpdir(),
    env: {
      ...process.env,
      CLAUDE_CODE_SESSION_ID: SESSION,
      KWOS_RELAY_URL: relayUrl,
      KWOS_XID_ACCESS_TOKEN: "test-token",
      KWOS_COLLAB_POLL_MS: "60000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (b) => { output += String(b); });
  child.stderr.on("data", (b) => { output += String(b); });
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, exited, output: () => output };
}

const SIGNALS = process.platform === "win32" ? [] : ["SIGTERM", "SIGINT", "SIGHUP"];

for (const signal of SIGNALS) {
  test(`Monitor meldet die Sitzung bei ${signal} ab und endet danach`, async () => {
    const fake = await startFakeRelay();
    const monitor = await startMonitor(fake.url);
    try {
      // Der Signal-Handler steht erst, wenn der SSE-Empfang aufgebaut wird (s. listen.js).
      await waitFor(() => fake.requests.some((r) => r.url.endsWith("/events")));
      monitor.child.kill(signal);

      const seen = await Promise.race([
        fake.unregistered,
        new Promise((_, reject) => setTimeout(() => reject(new Error(
          `keine Abmeldung nach ${signal}: ${monitor.output().slice(-400)}`
        )), 5000)),
      ]);
      assert.equal(seen.url, `/v1/sessions/${SESSION}/unregister`);
      assert.equal(seen.authorization, "Bearer test-token");

      const exit = await Promise.race([
        monitor.exited,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Prozess endet nicht")), 5000)),
      ]);
      assert.equal(exit.signal, null, `durch ${signal} getoetet statt abgemeldet: ${monitor.output().slice(-400)}`);
      assert.equal(exit.code, 0);
    } finally {
      monitor.child.kill("SIGKILL");
      await fake.close();
    }
  });
}
