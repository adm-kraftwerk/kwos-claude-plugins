// bot_memory (WI 11605710): the session's view of its bot's memory.
//
// The routes belong to the gateway (relay/sessionReadRoutes.js, relay/botRoutes.js); this suite
// pins the CLIENT half -- which routes the tool calls, what it says when the session has no bot,
// and that a refusal from the relay arrives as an answer instead of an exception.
import test from "node:test";
import assert from "node:assert/strict";
import { installFetchMock } from "./helpers/fetch-mock.js";

process.env.KWOS_XID_ACCESS_TOKEN = "test-token";
const { TOOLS, handleToolCall, callTool, visibleTools } = await import("../server/index.js");
const { config } = await import("../server/config.js");
config.sessionId = "sess-self";

/** The smallest Response the relay client needs: ok/status/headers/json. */
const json = (body, status = 200) =>
  Promise.resolve({ ok: status < 400, status, headers: { get: () => null }, json: async () => body });
const failure = (status, body) =>
  Promise.resolve({ ok: false, status, headers: { get: () => null }, text: async () => body });

const entry = {
  entry_id: "entry-1",
  kind: "fact",
  text: "Der Kunde rechnet in Preisen je Einheit.",
  source: "user",
  session_id: "sess-old",
  workitem: "11605710",
  created_at: "2026-11-01T10:00:00Z",
  updated_at: "2026-11-01T10:00:00Z",
};

/** Answers the session->bot lookup, and hands every other call to `onMemory`. */
function mockRoutes(botId, onMemory) {
  return installFetchMock((url, init) => {
    if (url.endsWith("/v1/sessions/sess-self/bot")) {
      return json({ session_id: "sess-self", bot_id: botId });
    }
    if (url.includes("/v1/bots/bot-7/memory")) return onMemory(url, init);
    throw new Error(`unerwarteter Aufruf: ${init?.method ?? "GET"} ${url}`);
  });
}

test("bot_memory is offered with a closed schema and both kinds", () => {
  const tool = TOOLS.find((t) => t.name === "bot_memory");
  assert.ok(tool, "bot_memory fehlt in TOOLS");
  assert.equal(tool.inputSchema.type, "object");
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.properties.kind.enum, ["fact", "work_log"]);
  assert.ok(tool.description.length > 60, "die Beschreibung ist die Anleitung des Agenten");
  assert.ok(visibleTools({}).some((t) => t.name === "bot_memory"), "ohne Schalter angeboten");
});

test("a session that belongs to no bot says so, and asks the bot routes nothing", async () => {
  // bot_id: null is a normal answer (an ordinary session); no memory request may follow from it.
  const mock = installFetchMock((url) => {
    assert.match(url, /\/v1\/sessions\/sess-self\/bot$/);
    return json({ session_id: "sess-self", bot_id: null });
  });
  try {
    const result = await callTool({ params: { name: "bot_memory", arguments: {} } });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /keinem Bot/);
    assert.equal(mock.calls.length, 1, "nur die Bot-Abfrage, keine Gedächtnis-Abfrage");
  } finally {
    mock.restore();
  }
});

test("a search names bot, kind and query in the URL and returns the entries as JSON", async () => {
  const mock = mockRoutes("bot-7", () => json({ bot_id: "bot-7", entries: [entry] }));
  try {
    const result = await handleToolCall("bot_memory", { kind: "fact", query: "Preis je" });
    const text = result.content[0].text;
    assert.match(text, /Bot bot-7/);
    assert.match(text, /\(kind=fact, Suche "Preis je"\)/);

    const body = text.slice(text.indexOf("\n") + 1);
    assert.deepEqual(JSON.parse(body), [entry]);
    assert.ok(!text.includes("test-token"), "der Token steht nie in der Antwort");

    assert.equal(mock.calls.length, 2, "erst der Bot, dann das Gedächtnis");
    const url = new URL(mock.calls[1].url);
    assert.equal(url.pathname, "/v1/bots/bot-7/memory");
    assert.equal(url.searchParams.get("kind"), "fact");
    assert.equal(url.searchParams.get("q"), "Preis je");
    assert.equal(mock.calls[1].init.method, "GET", "die Abfrage ist ein GET");
    assert.equal(mock.calls[1].init.headers.Authorization, "Bearer test-token");
  } finally {
    mock.restore();
  }
});

test("an empty result is a sentence, not an empty list", async () => {
  const mock = mockRoutes("bot-7", () => json({ bot_id: "bot-7", entries: [] }));
  try {
    const result = await handleToolCall("bot_memory", {});
    assert.match(result.content[0].text, /Bot bot-7 hat keine Einträge/);
  } finally {
    mock.restore();
  }
});

test("a failing relay reaches the model as its refusal (isError), not as a thrown exception", async () => {
  const mock = mockRoutes("bot-7", () => failure(502, "bad gateway"));
  try {
    const result = await callTool({ params: { name: "bot_memory", arguments: {} } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /502/);
    assert.match(result.content[0].text, /bad gateway/);
  } finally {
    mock.restore();
  }
});

test("adding one entry sends exactly the documented body and reports the new id", async () => {
  // The workitem is ambient in a bound session (KWOS_WORKITEM) -- pin it here so the test says
  // something about the client and not about the shell that runs it.
  const previousWorkitem = config.workitem;
  config.workitem = null;
  let posted = null;
  const mock = mockRoutes("bot-7", (url, init) => {
    posted = JSON.parse(init.body);
    assert.equal(init.method, "POST");
    return json({ ok: true, entry: { ...entry, entry_id: "entry-9", kind: "work_log" } }, 201);
  });
  try {
    const result = await handleToolCall("bot_memory", {
      add: "Die Preisfrage ist offen geblieben.",
      kind: "work_log",
    });
    assert.deepEqual(posted, {
      text: "Die Preisfrage ist offen geblieben.",
      source: "session",
      kind: "work_log",
      session_id: "sess-self",
    });
    assert.match(result.content[0].text, /entry-9/);
    assert.match(result.content[0].text, /work_log/);

    // The workitem travels as provenance when the session is bound to one.
    config.workitem = "11605710";
    await handleToolCall("bot_memory", { add: "noch ein Eintrag" });
    assert.equal(posted.workitem, "11605710");
  } finally {
    config.workitem = previousWorkitem;
    mock.restore();
  }
});

test("a text the relay deleted on purpose (409) arrives as the relay's sentence", async () => {
  const refusal = "this entry was deleted -- it does not come back by itself";
  const mock = mockRoutes("bot-7", () => failure(409, JSON.stringify({ error: refusal })));
  try {
    const result = await callTool({
      params: { name: "bot_memory", arguments: { add: "ein gelöschter Text" } },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /409/);
    assert.match(result.content[0].text, /does not come back/);
  } finally {
    mock.restore();
  }
});

test("add together with query is refused before any network call", async () => {
  const mock = installFetchMock(() => {
    throw new Error("fetch haette hier NICHT aufgerufen werden duerfen");
  });
  try {
    await assert.rejects(
      () => handleToolCall("bot_memory", { add: "x", query: "y" }),
      /schließen sich aus/
    );
    await assert.rejects(() => handleToolCall("bot_memory", { add: "   " }), /leer/);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("an unreadable memory answer is reported as such, not as an empty memory", async () => {
  const mock = mockRoutes("bot-7", () => json({ bot_id: "bot-7" })); // no `entries` field
  try {
    await assert.rejects(
      () => handleToolCall("bot_memory", {}),
      (err) => {
        assert.match(err.message, /kein lesbares JSON/);
        assert.ok(!/keine Einträge/.test(err.message), `falsche Ursache: ${err.message}`);
        return true;
      }
    );
  } finally {
    mock.restore();
  }
});
