// Der Empfänger überlebt, was die Flotte ihm antut (WI 11553492): ein Gateway, das neu startet,
// und eine Verbindung, die dabei HALB OFFEN bleibt.
//
// Der zweite Fall ist der gefährliche und der Grund für den Wachhund: endet eine Verbindung nicht
// sauber (Traefik-Tunnel, NAT, ein Prozess, der ohne FIN verschwindet), liefert `for await` kein
// Byte und keine Ausnahme -- der Kanal ist stumm, und niemand merkt es. Das Relay pingt alle 25 s;
// ein Strom, der 75 s nichts sagt, wird deshalb abgebrochen und neu geöffnet.
//
// Und die Zeilen: ein Ausfall ist EINE Meldung, seine Erholung EINE. Vorher schrieb jeder
// gescheiterte Versuch (2/4/8/16/30 s) eine Zeile, und ein Neustart hinterließ eine Zahlenwand.

import test from "node:test";
import assert from "node:assert/strict";
import { runSseReceiver, STALL_MS } from "../server/sse-receiver.js";
import { createStateReporter } from "../server/log.js";
import { installFetchMock } from "./helpers/fetch-mock.js";

const STREAM = "https://relay.example/v1/collabs/abc/events";

/** Eine SSE-Antwort aus Textstücken. `stalled` heißt: der Strom endet NIE. */
function sseResponse(chunks, { stalled = false } = {}) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      if (!stalled) controller.close();
    },
  });
  return { ok: true, status: 200, body };
}

/** Sammelt, was das Plugin auf stderr schreibt -- dort landen seine Meldungen (log.js). */
function captureStderr() {
  const original = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (chunk, ...rest) => {
    for (const line of String(chunk).split("\n")) if (line.trim() !== "") lines.push(JSON.parse(line));
    return true;
  };
  return { lines, restore: () => { process.stderr.write = original; } };
}

async function until(cond, ms = 6000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

test("a stalled stream is torn down and reopened -- instead of waiting for ever", async () => {
  const mock = installFetchMock(() => sseResponse([": ping\n\n"], { stalled: true }));
  const controller = new AbortController();
  try {
    void runSseReceiver(() => {}, {
      signal: controller.signal,
      url: STREAM,
      // Kurz, damit der Test nicht 75 s wartet: derselbe Weg, nur eine andere Zahl.
      stallMs: 100,
      getToken: async () => "token",
    });
    assert.ok(
      await until(() => mock.calls.length >= 2),
      `der schweigende Strom wurde nicht neu geöffnet (${mock.calls.length} Aufrufe)`,
    );
  } finally {
    controller.abort();
    mock.restore();
  }
});

test("a stall and its repair are TWO lines -- the attempts in between are silent", async () => {
  // Erst schweigt der Strom, dann antwortet das Relay nicht, danach kommt ein gesunder Strom.
  let round = 0;
  const mock = installFetchMock(() => {
    round += 1;
    if (round === 1) return sseResponse([], { stalled: true });
    if (round === 2) return { ok: false, status: 502, body: null };
    return sseResponse(["data: fertig\n\n"]);
  });
  const stderr = captureStderr();
  const controller = new AbortController();
  try {
    void runSseReceiver(() => {}, {
      signal: controller.signal,
      url: STREAM,
      stallMs: 50,
      // Die Wartezeit zwischen zwei Versuchen ist im Betrieb 2 s -> 30 s; hier nur die Naht, damit
      // der Test nicht 6 s auf drei Runden wartet.
      retryMs: 20,
      retryMaxMs: 40,
      getToken: async () => "token",
    });
    assert.ok(
      await until(() => stderr.lines.some((l) => l.state === "recovered")),
      `keine Erholung gemeldet: ${JSON.stringify(stderr.lines.map((l) => l.message))}`,
    );
    const failures = stderr.lines.filter((l) => l.state === "failed");
    const recoveries = stderr.lines.filter((l) => l.state === "recovered");
    assert.equal(failures.length, 1, `mehr als eine Ausfallzeile: ${JSON.stringify(failures)}`);
    assert.equal(recoveries.length, 1, `mehr als eine Erholungszeile: ${JSON.stringify(recoveries)}`);
    assert.match(failures[0].message, /schweigt/, "der Ausfall muss als Schweigen benannt sein");
  } finally {
    controller.abort();
    stderr.restore();
    mock.restore();
  }
});

test("the last event id travels into the reconnect", async () => {
  // Das Relay liefert mit `Last-Event-ID` nur, was danach kam -- hier nachgebaut, damit der Test
  // beides prüft: die Kopfzeile UND dass eine Wiederverbindung den Verlauf nicht wiederholt.
  const mock = installFetchMock((_url, init) =>
    init?.headers?.["Last-Event-ID"] === "7"
      ? sseResponse(["id: 8\ndata: weiter\n\n"])
      : sseResponse(["id: 7\ndata: hallo\n\n"]),
  );
  const controller = new AbortController();
  try {
    const seen = [];
    void runSseReceiver((text) => seen.push(text), {
      signal: controller.signal,
      url: STREAM,
      retryMs: 20,
      retryMaxMs: 40,
      getToken: async () => "token",
    });
    assert.ok(
      await until(() => seen.length >= 2),
      `kein Neuaufbau nach dem Stromende (${JSON.stringify(seen)})`,
    );
    assert.equal(mock.calls[1].init.headers["Last-Event-ID"], "7");
    assert.deepEqual(seen.slice(0, 2), ["hallo", "weiter"]);
  } finally {
    controller.abort();
    mock.restore();
  }
});

test("the reporter writes once per state change", () => {
  const lines = [];
  const writer = {
    info: (message, extra) => lines.push({ level: "info", message, ...extra }),
    error: (message, extra) => lines.push({ level: "error", message, ...extra }),
  };
  const state = createStateReporter(writer);
  state.failed("a", "weg", {});
  state.failed("a", "weg", {});
  state.failed("b", "auch weg", {});
  state.failed("a", "weg", {});
  state.recovered("a", "wieder da", {});
  state.recovered("a", "wieder da", {});
  assert.deepEqual(
    lines.map((l) => `${l.level}:${l.message}`),
    ["error:weg", "error:auch weg", "info:wieder da"],
  );
  // Ein Gegenstand, der verschwindet, meldet sich nicht als gesund.
  state.forget("b");
  state.recovered("b", "wieder da", {});
  assert.equal(lines.length, 3);
});

test("the stall window is three ping intervals -- the relay pings every 25 s", () => {
  assert.equal(STALL_MS, 75_000);
});
