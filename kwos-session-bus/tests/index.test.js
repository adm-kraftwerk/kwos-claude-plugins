import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { installFetchMock } from "./helpers/fetch-mock.js";

process.env.KWOS_XID_ACCESS_TOKEN = "test-token";
const { TOOLS, handleToolCall, callTool } = await import("../server/index.js");
const { config } = await import("../server/config.js");
const collab = await import("../server/collab.js");
config.sessionId = "sess-self";

test("TOOLS enthaelt get_attachment mit attachment_id als Pflichtfeld", () => {
  const tool = TOOLS.find((t) => t.name === "get_attachment");
  assert.ok(tool, "get_attachment fehlt in TOOLS");
  assert.deepEqual(tool.inputSchema.required, ["attachment_id"]);
  assert.equal(tool.inputSchema.properties.attachment_id.type, "string");
});

test("handleToolCall('get_attachment') liefert einen echten Bild-Content-Block, kein Text", async () => {
  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG-Magic-Bytes
  const mock = installFetchMock(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: (n) => (n.toLowerCase() === "content-type" ? "image/jpeg" : null) },
      arrayBuffer: async () => jpegBytes.buffer.slice(jpegBytes.byteOffset, jpegBytes.byteOffset + jpegBytes.byteLength),
    })
  );
  try {
    const result = await handleToolCall("get_attachment", { attachment_id: "att-xyz" });
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "image");
    assert.equal(result.content[0].mimeType, "image/jpeg");
    assert.equal(result.content[0].data, jpegBytes.toString("base64"));
  } finally {
    mock.restore();
  }
});

test("callTool: Relay-Fehler (403) wird zu isError statt einer geworfenen Exception", async () => {
  const mock = installFetchMock(() =>
    Promise.resolve({
      ok: false,
      status: 403,
      headers: { get: () => null },
      text: async () => JSON.stringify({ error: "not allowed to view this attachment" }),
    })
  );
  try {
    const result = await callTool({ params: { name: "get_attachment", arguments: { attachment_id: "fremd" } } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /403/);
  } finally {
    mock.restore();
  }
});

test("handleToolCall: unbekanntes Tool wirft (kein stiller No-Op)", async () => {
  await assert.rejects(() => handleToolCall("does_not_exist", {}), /Unbekanntes Tool/);
});

// Das Bundle ist die Datei, die `.mcp.json` startet -- ein vergessenes `npm run build` heisst, dass
// in Produktion der ALTE MCP-Server laeuft (genau so schon einmal passiert, s. README). Waehrend
// der Arbeit an WI 11075502 ist das Bundle zweimal veraltet gewesen. Dieser Test macht daraus
// einen roten Test statt eines still veralteten Servers.
test("committed index.bundle.mjs entspricht dem aktuellen Quellstand", async (t) => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  // esbuild ueber seine JS-API statt ueber node_modules/.bin/esbuild: der Eintrag dort ist eine
  // Shell-Datei OHNE Endung (auf POSIX ein Symlink auf das Binary). execFileSync kann sie auf
  // Windows nicht starten -- der Aufruf starb mit ENOENT, existSync() sah die Datei aber, also
  // griff auch der skip-Zweig darunter nicht. Ergebnis: auf Windows war dieses Gate DAUERROT,
  // und zwar unabhaengig vom Code -- ein Gate, das nur auf einer Plattform laufen kann.
  let build;
  try {
    ({ build } = await import("esbuild"));
  } catch {
    // Frischer Klon ohne `npm install` -- kein Fehlschlag, nur kein Pruefwert.
    t.skip("esbuild nicht installiert (npm install) -- Bundle-Abgleich uebersprungen");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "kwos-bundle-"));
  const out = join(dir, "index.bundle.mjs");
  try {
    await build({
      entryPoints: [join(here, "..", "server", "index.js")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: out,
      external: ["node:*"],
      logLevel: "silent",
    });
    const fresh = readFileSync(out);
    const committed = readFileSync(join(here, "..", "server", "index.bundle.mjs"));
    assert.ok(
      fresh.equals(committed),
      "server/index.bundle.mjs ist veraltet -- `npm run build` ausfuehren und die Datei mitcommitten"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── get_message (WI 11075502) ─────────────────────────────────────────────────

test("TOOLS enthaelt get_message mit seq als Pflichtfeld", () => {
  const tool = TOOLS.find((t) => t.name === "get_message");
  assert.ok(tool, "get_message fehlt in TOOLS");
  assert.deepEqual(tool.inputSchema.required, ["seq"]);
  assert.equal(tool.inputSchema.properties.seq.type, "integer");
});

test("handleToolCall('get_message') liefert den vollen Text der nachgeholten Nachricht", async () => {
  const full = "x".repeat(5000);
  const mock = installFetchMock(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ messages: [{ seq: 5, from_session: "sess-abc", text: full, attachment_id: null }] }),
    })
  );
  try {
    const result = await handleToolCall("get_message", { seq: 5 });
    assert.equal(result.content[0].text, full);
  } finally {
    mock.restore();
  }
});

test("handleToolCall('get_message') nennt den Bildhinweis, holt das Bild aber nicht selbst", async () => {
  const mock = installFetchMock(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ messages: [{ seq: 6, from_session: "sess-abc", text: "kurz", attachment_id: "att-9" }] }),
    })
  );
  try {
    const result = await handleToolCall("get_message", { seq: 6 });
    assert.match(result.content[0].text, /kurz/);
    assert.match(result.content[0].text, /attachment_id=att-9/);
    // Kein Autowake: der Abruf des Bildes bleibt eine eigene Entscheidung (get_attachment).
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test("get_message-Beschreibung verspricht den vollen Text UND benennt die Relay-Teilung", () => {
  const tool = TOOLS.find((t) => t.name === "get_message");
  assert.match(tool.description, /vollst/i);
  // Der Relay teilt lange Nachrichten in Chunks (F1 aus dem Review) -- die Beschreibung darf
  // nicht den Eindruck erwecken, eine einzelne Zeile sei immer schon die ganze Nachricht.
  assert.match(tool.description, /geteilt|Teile|Teil /i);
});

test("handleToolCall('get_message') meldet eine unvollstaendige Teilfolge statt sie zu verschweigen", async () => {
  const mock = installFetchMock(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        messages: [
          { seq: 10, from_session: "sess-abc", text: "(1/3) erster Teil", attachment_id: null },
          { seq: 11, from_session: "sess-abc", text: "(2/3) zweiter Teil", attachment_id: null },
        ],
      }),
    })
  );
  try {
    const result = await handleToolCall("get_message", { seq: 10 });
    assert.match(result.content[0].text, /erster Teil zweiter Teil/);
    assert.match(result.content[0].text, /unvollst/i);
    assert.match(result.content[0].text, /12/); // die fehlende seq wird benannt
  } finally {
    mock.restore();
  }
});

// ── kwcollab-Werkzeuge (WI 11482928) ─────────────────────────────────────────────────────────

test("TOOLS enthaelt die kwcollab-Werkzeuge -- Einladen ja, Rauswerfen/Schliessen nein", () => {
  const names = TOOLS.map((t) => t.name);
  for (const t of [
    "collab_status", "collab_send", "collab_accept", "collab_leases", "collab_lease",
    "collab_release", "collab_get_attachment", "collab_get_message",
  ]) {
    assert.ok(names.includes(t), `${t} fehlt in TOOLS`);
  }
  // EINLADEN IST SEIT 2026-10-25 (WI 11553520) AUCH EIN WERKZEUG DES AGENTEN. Die frueher hier
  // stehende Regel ("Einladen ist eine Handlung eines Menschen") hat den Agenten nicht daran
  // gehindert -- er hat es ueber `kwclaude invite` getan, nur durch eine Kette durch den lokalen
  // kwterm-Server. Ein Werkzeug ist der ehrliche Weg: es steht in der Werkzeugliste, der Relay
  // urteilt (nur der Maintainer), und der Kanal nennt die Herkunft ("(via claude)"). Rauswerfen,
  // Uebergeben und Schliessen bleiben beim Menschen -- die sind hier weiterhin verboten.
  assert.ok(names.includes("collab_invite"), "collab_invite fehlt in TOOLS");
  for (const verboten of ["collab_kick", "collab_close", "collab_handover"]) {
    assert.ok(!names.includes(verboten), `${verboten} darf es nicht geben`);
  }
});

test("collab_accept ohne Ziel nennt den Grund, statt ins Leere zu greifen", async () => {
  const before = config.collab;
  config.collab = null;
  try {
    await assert.rejects(() => handleToolCall("collab_accept", {}), /Kein Kanal angegeben/);
  } finally {
    config.collab = before;
  }
});

test("collab_send bietet die Kurzform an -- und verlangt sie nicht (WI 11538037)", () => {
  const tool = TOOLS.find((t) => t.name === "collab_send");
  assert.ok(tool, "collab_send fehlt in TOOLS");
  assert.equal(tool.inputSchema.properties.summary.type, "string");
  // Eine Pflicht waere ein Bruch: eine kurze Nachricht braucht keine Kurzform, und ein Agent, der
  // sie vergisst, soll nicht am Schema scheitern -- der Kanal leitet sie dann aus dem Text ab.
  assert.deepEqual(tool.inputSchema.required, ["text"]);
  assert.match(tool.inputSchema.properties.summary.description, /280/);
});

test("collab_send schreibt ohne from_human als 'claude' und mit ihm als 'human'", async () => {
  // Der Pausen-Zaehler zaehlt Agenten-Nachrichten in Folge. Wer die Worte seines Nutzers wortgleich
  // weitergibt, ist der MENSCH, der spricht -- `from_human` sagt das dem Relay. Der Test geht an
  // `sendCollabMessage` vorbei an der Kanalsuche: die ist hier nicht der Gegenstand.
  const bodies = [];
  const mock = installFetchMock((url, init) => {
    bodies.push(JSON.parse(init.body));
    return Promise.resolve({
      ok: true, status: 200, headers: { get: () => "application/json" },
      json: async () => ({ message: { seq: 1 }, claude_streak: 0 }),
    });
  });
  try {
    await collab.sendCollabMessage("c-1", "Befund: 502 kommt nach 60 s.");
    await collab.sendCollabMessage("c-1", "frag tim nach einem witz", null, true);
    assert.equal(bodies[0].author_kind, "claude");
    assert.equal(bodies[1].author_kind, "human");
  } finally {
    mock.restore();
  }
});

// ── collab_get_message (WI 11536314) ─────────────────────────────────────────────────────────
//
// Die Kanal-Nachricht, die der Monitor teilt, traegt ihre seq im Kopf. Genau damit holt dieses
// Werkzeug den vollen Text -- ueber die EIGENE Kanal-Route, nicht ueber den Session-Verlauf
// (get_message): Kanal-Nachrichten stehen dort nicht.

/** Ein Kanal dieses Logins, wie `GET /v1/collabs` ihn liefert. */
const joinedCollab = () => ({
  collab_id: "7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c",
  workitem: "11536314",
  my_status: "joined",
  members: [{ subject: "u-mara", session_id: "sess-self", status: "joined" }],
});

/** Antwortet auf die Kanalliste und auf die Einzel-Nachricht; alles andere ist ein Testfehler. */
const messageMock = (message) =>
  installFetchMock((url) => {
    const body = url.endsWith("/v1/collabs") ? { collabs: [joinedCollab()] } : { message };
    return Promise.resolve({
      ok: true, status: 200,
      headers: { get: () => "application/json" },
      json: async () => body,
    });
  });

test("collab_get_message holt den vollen Text EINER Kanal-Nachricht ueber ihre seq", async () => {
  const full = "Befund: ".repeat(200); // laenger als eine Monitor-Zeile -- genau der Fall
  const mock = messageMock({ seq: 12, text: full, attachment_id: null });
  try {
    const out = await handleToolCall("collab_get_message", { seq: 12 });
    assert.equal(out.content[0].text, full);
    assert.match(
      mock.calls[1].url,
      /\/v1\/collabs\/7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c\/messages\/12$/,
      "die Einzel-Nachricht kommt ueber die Kanal-Route, nicht ueber den Session-Verlauf",
    );
  } finally { mock.restore(); }
});

test("collab_get_message kuendigt einen Anhang an, holt ihn aber nicht selbst", async () => {
  const mock = messageMock({ seq: 13, text: "kurz", attachment_id: "att-9" });
  try {
    const out = await handleToolCall("collab_get_message", { seq: 13 });
    assert.match(out.content[0].text, /kurz/);
    assert.match(out.content[0].text, /attachment_id=att-9/);
    assert.equal(mock.calls.length, 2, "kein Autowake: kein dritter Abruf");
  } finally { mock.restore(); }
});

test("collab_get_message: eine 404 (unbekannte oder ausgeraeumte seq) wird zum Satz, nicht zu leerem Text", async () => {
  const mock = installFetchMock((url) => {
    if (url.endsWith("/v1/collabs")) {
      return Promise.resolve({
        ok: true, status: 200, headers: { get: () => "application/json" },
        json: async () => ({ collabs: [joinedCollab()] }),
      });
    }
    return Promise.resolve({
      ok: false, status: 404, headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ error: "message unknown" }),
    });
  });
  try {
    const out = await callTool({ params: { name: "collab_get_message", arguments: { seq: 99 } } });
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /404/);
    assert.match(out.content[0].text, /message unknown/);
  } finally { mock.restore(); }
});

test("collab_accept schickt die EIGENE session_id an den Relay", async () => {
  const mock = installFetchMock(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ me: { status: "joined" } }),
    })
  );
  try {
    const out = await handleToolCall("collab_accept", { collab_id: "7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c" });
    assert.match(out.content[0].text, /beigetreten/);
    const body = JSON.parse(mock.calls[0].init.body);
    assert.equal(body.session_id, "sess-self", "nur DIESE Sitzung darf sich anmelden");
    assert.match(mock.calls[0].url, /\/v1\/collabs\/7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c\/accept$/);
  } finally {
    mock.restore();
  }
});
