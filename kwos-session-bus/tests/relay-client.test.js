import test from "node:test";
import assert from "node:assert/strict";
import { installFetchMock } from "./helpers/fetch-mock.js";

// KWOS_XID_ACCESS_TOKEN MUSS gesetzt sein, BEVOR config.js geladen wird (TOKEN_OVERRIDE wird
// einmalig beim Modul-Import aus process.env gelesen, s. server/config.js) -- deshalb kein
// statisches `import`, sondern ein dynamisches nach dem Setzen, das in Programmreihenfolge laeuft.
process.env.KWOS_XID_ACCESS_TOKEN = "test-token";
const { config } = await import("../server/config.js");
const relay = await import("../server/relay-client.js");

test("getAttachment: liefert mimeType + Base64 aus einer echten Binaer-Antwort", async () => {
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG-Magic-Bytes
  const mock = installFetchMock(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: (n) => (n.toLowerCase() === "content-type" ? "image/png" : null) },
      arrayBuffer: async () => pngBytes.buffer.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.byteLength),
    })
  );
  try {
    const result = await relay.getAttachment("11111111-1111-1111-1111-111111111111");
    assert.equal(result.mimeType, "image/png");
    assert.equal(result.data, pngBytes.toString("base64"));
    assert.equal(mock.calls.length, 1);
    assert.match(mock.calls[0].url, /\/v1\/attachments\/11111111-1111-1111-1111-111111111111$/);
    assert.equal(mock.calls[0].init.headers.Authorization, "Bearer test-token");
  } finally {
    mock.restore();
  }
});

test("getAttachment: 403 (fremdes Bild) wirft mit Status UND Server-Fehlertext", async () => {
  const mock = installFetchMock(() =>
    Promise.resolve({
      ok: false,
      status: 403,
      headers: { get: () => null },
      text: async () => JSON.stringify({ error: "not allowed to view this attachment" }),
    })
  );
  try {
    await assert.rejects(
      () => relay.getAttachment("22222222-2222-2222-2222-222222222222"),
      (err) => {
        assert.match(err.message, /403/);
        assert.match(err.message, /not allowed to view this attachment/);
        return true;
      }
    );
  } finally {
    mock.restore();
  }
});

test("getAttachment: 404 (abgelaufen/unbekannt) wirft ebenfalls, kein stiller leerer Rueckgabewert", async () => {
  const mock = installFetchMock(() =>
    Promise.resolve({
      ok: false,
      status: 404,
      headers: { get: () => null },
      text: async () => JSON.stringify({ error: "attachment unknown or expired" }),
    })
  );
  try {
    await assert.rejects(() => relay.getAttachment("33333333-3333-3333-3333-333333333333"), /404/);
  } finally {
    mock.restore();
  }
});

test("getAttachment: ohne KWOS_RELAY_URL wirft VOR jedem Netzwerkaufruf", async () => {
  const original = config.relayUrl;
  config.relayUrl = undefined;
  const mock = installFetchMock(() => {
    throw new Error("fetch haette hier NICHT aufgerufen werden duerfen");
  });
  try {
    await assert.rejects(() => relay.getAttachment("44444444-4444-4444-4444-444444444444"), /KWOS_RELAY_URL/);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
    config.relayUrl = original;
  }
});
