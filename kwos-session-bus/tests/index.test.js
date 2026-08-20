import test from "node:test";
import assert from "node:assert/strict";
import { installFetchMock } from "./helpers/fetch-mock.js";

process.env.KWOS_XID_ACCESS_TOKEN = "test-token";
const { TOOLS, handleToolCall, callTool } = await import("../server/index.js");

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
