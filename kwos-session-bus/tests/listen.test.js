import test from "node:test";
import assert from "node:assert/strict";

// KWOS_XID_ACCESS_TOKEN vor jedem Import setzen (s. relay-client.test.js) -- listen.js importiert
// transitiv relay-client.js -> config.js. Kein main()-Aufruf beim Import (Guard in listen.js).
process.env.KWOS_XID_ACCESS_TOKEN = "test-token";
const { formatLine } = await import("../server/listen.js");

test("normale Textnachricht ohne Attachment", () => {
  const raw = JSON.stringify({ from_session: "sess-abc", text: "hallo" });
  assert.equal(formatLine(raw), "[sess-abc]: hallo");
});

test("Bildnachricht OHNE Text: Hinweis statt der rohen JSON-Zeile (Regression)", () => {
  // relay/lib.js serialize() liefert text:null, wenn eine Nachricht nur ein Bild traegt (relay/
  // server.js akzeptiert "text ODER attachment_id"). Der urspruengliche "?? rawData"-Fallback
  // haette hier die GESAMTE rohe JSON-Zeile als "Text" gezeigt -- genau das darf nicht passieren.
  const raw = JSON.stringify({ from_session: "sess-abc", text: null, attachment_id: "att-1" });
  const line = formatLine(raw);
  assert.ok(!line.includes('"attachment_id"'), `rohe JSON-Zeile ist durchgesickert: ${line}`);
  assert.ok(!line.includes('"from_session"'), `rohe JSON-Zeile ist durchgesickert: ${line}`);
  assert.match(line, /^\[sess-abc\]: \(Bild ohne Text\) \[Bild angehängt, attachment_id=att-1/);
});

test("Bildnachricht MIT Text: beides sichtbar", () => {
  const raw = JSON.stringify({ from_session: "sess-abc", text: "schau mal", attachment_id: "att-2" });
  const line = formatLine(raw);
  assert.match(line, /^\[sess-abc\]: schau mal \[Bild angehängt, attachment_id=att-2/);
});

test("kein from_session -> Fallback 'unknown'", () => {
  const raw = JSON.stringify({ text: "ohne Absender" });
  assert.equal(formatLine(raw), "[unknown]: ohne Absender");
});

test("kaputtes JSON faellt unveraendert auf rawData zurueck", () => {
  const raw = "das ist kein JSON";
  assert.equal(formatLine(raw), raw);
});
