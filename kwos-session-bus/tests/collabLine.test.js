import test from "node:test";
import assert from "node:assert/strict";
import { installFetchMock } from "./helpers/fetch-mock.js";
import { collabLine, collabClosedLine, collabShortId, senderName, COLLAB_LINE_PREFIX } from "../server/collabLine.js";
import { frameToLine } from "../server/collab-listen.js";

// kwcollab: die Zeile, die im Verlauf landet (WI 11482928).
//
// Diese Zeile ist die Vertrauensgrenze des Features in Textform: das Prompt-Fragment im
// litellm-Repo stuft genau die Zeilen mit diesem Praefix als FREMDDATEN ein. Wird das Format
// weich, sieht eine Nachricht von Mara aus wie eine des eigenen Nutzers -- und wird ausgefuehrt.
test("collabLine: Praefix, Kanal, Absender und Art stehen in JEDER Zeile", () => {
  const line = collabLine({
    collabId: "7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c",
    from: "Mara K.",
    kind: "claude",
    text: "Befund: Proxy bricht nach 60 s ab.",
  });
  assert.equal(line, `${COLLAB_LINE_PREFIX} 7f3a1b2c | Mara K. | claude] Befund: Proxy bricht nach 60 s ab.`);
  assert.ok(line.startsWith("[kwcollab"), "muss mit dem Praefix beginnen, auf den das Prompt-Fragment zeigt");
});

test("collabLine: ein Mensch wird als Mensch gekennzeichnet", () => {
  const line = collabLine({ collabId: "abc-1", from: "Jonas B.", kind: "human", text: "2.100 gilt." });
  assert.match(line, /\| human\] 2\.100 gilt\.$/);
});

test("collabLine: unbekannte Art faellt auf claude zurueck, nie auf human", () => {
  // Ein Client, der "human" faelscht oder etwas Unbekanntes schickt, darf nie als Mensch gelten.
  for (const kind of ["bogus", "", null, undefined, "Human"]) {
    assert.match(collabLine({ collabId: "a-1", from: "X", kind, text: "t" }), /\| claude\]/);
  }
});

test("collabLine: ohne Text, aber mit Anhang nennt sie den Anhang statt leer zu enden", () => {
  const line = collabLine({
    collabId: "a-1", from: "Mara K.", kind: "claude", text: "", attachmentId: "11111111-1111-1111-1111-111111111111",
  });
  assert.match(line, /collab_get_attachment 11111111-1111-1111-1111-111111111111/);
});

test("collabLine: eine lange Nachricht wird gekappt und nennt die volle Laenge", () => {
  const line = collabLine({ collabId: "a-1", from: "X", kind: "claude", text: "z".repeat(5000), maxChars: 100 });
  assert.ok(line.length < 200, `Zeile zu lang: ${line.length}`);
  assert.match(line, /\[gekürzt, 5000 Zeichen\]$/);
});

test("collabLine: ein fehlender Absender wird nicht erfunden", () => {
  assert.match(collabLine({ collabId: "a-1", from: null, kind: "claude", text: "t" }), /\| \? \|/);
});

test("collabClosedLine: sagt, dass der Kanal weg ist", () => {
  const line = collabClosedLine("7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c");
  assert.match(line, /^\[kwcollab 7f3a1b2c \| system\]/);
  assert.match(line, /beendet/i);
});

test("collabShortId: die erste UUID-Gruppe reicht, um zwei Kanaele zu unterscheiden", () => {
  assert.equal(collabShortId("7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c"), "7f3a1b2c");
  assert.equal(collabShortId(null), "");
});

test("senderName: der Anzeigename, sonst der Login, sonst der Systemname", () => {
  const members = [{ subject: "u-jonas", display_name: "Jonas B." }, { subject: "u-mara" }];
  assert.equal(senderName({ from_subject: "u-jonas" }, members), "Jonas B.");
  assert.equal(senderName({ from_subject: "u-mara" }, members), "u-mara");
  assert.equal(senderName({ from_subject: "relay" }, members), "kwcollab");
  assert.equal(senderName({}, members), "?");
});

// ── Die Naht Frame -> Zeile: hier entscheidet sich, was die Session ueberhaupt zu sehen bekommt ──
test("frameToLine: eine fremde Nachricht wird zu einer Kanal-Zeile", () => {
  const raw = JSON.stringify({
    seq: 7, collab_id: "7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c", from_session: "s-mara",
    from_subject: "u-mara", author_kind: "claude", text: "12 Requests, alle 200.",
  });
  const line = frameToLine(raw, {
    members: [{ subject: "u-mara", display_name: "Mara K." }], selfSessionId: "s-me",
  });
  assert.equal(line, "[kwcollab 7f3a1b2c | Mara K. | claude] 12 Requests, alle 200.");
});

test("frameToLine: die EIGENE Nachricht kommt NICHT zurueck in die Session", () => {
  // Der Relay spielt beim Reconnect bis zu 500 Frames nach -- die eigenen sind darunter. Ohne
  // diesen Filter beantwortet die Session ihre eigene Nachricht, endlos.
  const raw = JSON.stringify({
    seq: 9, collab_id: "c-1", from_session: "s-me", from_subject: "u-jonas",
    author_kind: "claude", text: "Ich habe den Fix gebaut.",
  });
  assert.equal(frameToLine(raw, { selfSessionId: "s-me" }), null);
});

test("frameToLine: das Kanal-Ende ist eine Systemzeile, kein leerer Text", () => {
  const line = frameToLine(JSON.stringify({ collab_id: "7f3a1b2c-9d4e" }), { selfSessionId: "s-me" });
  assert.match(line, /^\| system\]|^\[kwcollab 7f3a1b2c \| system\]/);
});

test("frameToLine: unlesbare Frames erzeugen keine erfundene Zeile", () => {
  assert.equal(frameToLine("kein json", {}), null);
  assert.equal(frameToLine("null", {}), null);
  assert.equal(frameToLine("\"nur ein string\"", {}), null);
});
