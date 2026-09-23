import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { installFetchMock } from "./helpers/fetch-mock.js";

process.env.KWOS_XID_ACCESS_TOKEN = "test-token";
const { TOOLS, handleToolCall, callTool } = await import("../server/index.js");
const { config } = await import("../server/config.js");
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
test("committed index.bundle.mjs entspricht dem aktuellen Quellstand", (t) => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const esbuild = join(here, "..", "node_modules", ".bin", "esbuild");
  if (!existsSync(esbuild)) {
    // Frischer Klon ohne `npm install` -- kein Fehlschlag, nur kein Pruefwert.
    t.skip("esbuild nicht installiert (npm install) -- Bundle-Abgleich uebersprungen");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "kwos-bundle-"));
  const out = join(dir, "index.bundle.mjs");
  try {
    execFileSync(
      esbuild,
      ["server/index.js", "--bundle", "--platform=node", "--format=esm", `--outfile=${out}`, "--external:node:*"],
      { cwd: join(here, ".."), stdio: "pipe" }
    );
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
