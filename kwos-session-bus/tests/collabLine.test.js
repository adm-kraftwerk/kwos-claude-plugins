import test from "node:test";
import assert from "node:assert/strict";
import { installFetchMock } from "./helpers/fetch-mock.js";
import { collabLine, collabLines, collabClosedLine, collabShortId, senderName, COLLAB_LINE_PREFIX } from "../server/collabLine.js";
import { frameToLine } from "../server/collab-listen.js";
import { MAX_LINE_CHARS } from "../server/listen.js";

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

test("collabLine: eine lange Nachricht wird gekappt und nennt den Verlust", () => {
  const line = collabLine({ collabId: "a-1", from: "X", kind: "claude", text: "z".repeat(5000), maxChars: 100 });
  assert.ok(line.length <= 100, `Zeile zu lang: ${line.length}`);
  assert.match(line, /Rest fehlt: 5000 Zeichen gesamt\]$/);
});

// Review-Fund 2026-10-16: gekappt werden muss die GANZE Zeile, nicht der Text. Claude Code kappt
// jede Monitor-Zeile bei 500 Zeichen und zwar am ZEILENENDE (WI 11075502, gemessen) -- genau dort,
// wo der Kuerzungs-Marker steht. Nur den Text zu kappen brachte die Zeile auf ~540-560 Zeichen: die
// Kappung frass den Marker, und die Nachricht kam abgeschnitten an, ohne dass es jemand sah.
test("collabLine: die ganze Zeile bleibt im Budget, auch im Worst Case", () => {
  const line = collabLine({
    collabId: "7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c",
    from: "M".repeat(120),            // der Absender kommt vom Relay, seine Laenge ist nicht unsere
    kind: "claude",
    text: "z".repeat(5000),
    attachmentId: "11111111-1111-1111-1111-111111111111",
  });
  assert.ok(line.length <= MAX_LINE_CHARS, `Zeile zu lang: ${line.length}`);
  assert.match(line, /Rest fehlt: 5000 Zeichen gesamt\]$/, "der Marker muss die Kappung ueberleben");
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
  const lines = frameToLine(raw, {
    members: [{ subject: "u-mara", display_name: "Mara K." }], selfSessionId: "s-me",
  });
  assert.deepEqual(lines, ["[kwcollab 7f3a1b2c | Mara K. | claude] 12 Requests, alle 200."]);
});

test("frameToLine: die EIGENE Nachricht des Agenten kommt NICHT zurueck in die Session", () => {
  // Der Relay spielt beim Reconnect bis zu 500 Frames nach -- die eigenen sind darunter. Ohne
  // diesen Filter beantwortet die Session ihre eigene Nachricht, endlos.
  const raw = JSON.stringify({
    seq: 9, collab_id: "c-1", from_session: "s-me", from_subject: "u-jonas",
    author_kind: "claude", text: "Ich habe den Fix gebaut.",
  });
  assert.equal(frameToLine(raw, { selfSessionId: "s-me" }), null);
});

test("frameToLine: eine MENSCHEN-Nachricht aus DIESER Sitzung kommt AN", () => {
  // Gemessen 2026-10-19 (tgoebel): der Relay stempelt eine Nachricht, die der Mensch in der
  // Kanal-Ansicht DIESER Pane schreibt, mit der Kennung dieser Sitzung -- sie laeuft durch diesen
  // Server. Ein Filter allein auf `from_session` wirft damit genau die Nachricht weg, fuer die der
  // Kanal da ist: der Mensch erreichte seine eigene Sitzung ueber ihren Kanal nicht.
  const raw = JSON.stringify({
    seq: 12, collab_id: "c-1", from_session: "s-me", from_subject: "u-jonas",
    author_kind: "human", text: "Fasse die wichtigsten Schritte zusammen.",
  });
  const lines = frameToLine(raw, { selfSessionId: "s-me" });
  assert.ok(lines !== null, "die Menschen-Nachricht darf NICHT verworfen werden");
  assert.match(lines[0], /Fasse die wichtigsten Schritte zusammen\./);
  assert.match(lines[0], /\| human\]/);
});

test("frameToLine: das Kanal-Ende ist eine Systemzeile, kein leerer Text", () => {
  const lines = frameToLine(JSON.stringify({ collab_id: "7f3a1b2c-9d4e" }), { selfSessionId: "s-me" });
  assert.match(lines[0], /^\[kwcollab 7f3a1b2c \| system\]/);
});

test("frameToLine: unlesbare Frames erzeugen keine erfundene Zeile", () => {
  assert.equal(frameToLine("kein json", {}), null);
  assert.equal(frameToLine("null", {}), null);
  assert.equal(frameToLine("\"nur ein string\"", {}), null);
});

// ── Long channel messages: split into parts, never cut ──────────────────────────────────────

const COLLAB_ID = "7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c";
const LONG_HEAD = `${COLLAB_LINE_PREFIX} 7f3a1b2c | Mara K. | claude] `;

/** Strip the framing and "(i/n) " from each part; the result must be the original text. */
function rebuild(lines, head = LONG_HEAD) {
  return lines.map((line, i) => {
    const prefix = `${head}(${i + 1}/${lines.length}) `;
    assert.ok(line.startsWith(prefix), `part ${i + 1} lacks its framing or number: ${line.slice(0, 90)}`);
    return line.slice(prefix.length);
  }).join("");
}

test("collabLines: a 3000-character message arrives complete, in order, reconstructable", () => {
  const body = Array.from({ length: 3000 }, (_, i) => "abcdefghij"[i % 10]).join("");
  const lines = collabLines({ collabId: COLLAB_ID, from: "Mara K.", kind: "claude", text: body });
  assert.ok(lines.length > 1, "eine 3000-Zeichen-Nachricht passt nicht in eine Zeile");
  for (const line of lines) {
    assert.ok(line.length <= MAX_LINE_CHARS, `line is ${line.length} chars (limit ${MAX_LINE_CHARS})`);
    // The measured harness limit is 500 characters per line; MAX_LINE_CHARS keeps a reserve.
    assert.ok(line.length <= 500, `line is ${line.length} chars, above the harness limit`);
    assert.ok(line.startsWith(COLLAB_LINE_PREFIX), "every part must carry the foreign-data framing");
    assert.doesNotMatch(line, /\[gekürzt/, "nothing may be cut when splitting is possible");
  }
  assert.equal(rebuild(lines), body, "the parts must add up to the whole message");
});

test("frameToLine: a long channel message becomes several framed lines", () => {
  const body = "seed=31337 move=Qd4 ".repeat(160); // 3040 characters
  const lines = frameToLine(JSON.stringify({
    seq: 8, collab_id: COLLAB_ID, from_session: "s-mara", from_subject: "u-mara",
    author_kind: "human", text: body,
  }), { members: [{ subject: "u-mara", display_name: "Mara K." }], selfSessionId: "s-me" });
  assert.ok(Array.isArray(lines), "frameToLine must hand the writer every part");
  assert.ok(lines.length > 1);
  for (const line of lines) assert.ok(line.length <= MAX_LINE_CHARS);
  assert.equal(rebuild(lines, `${COLLAB_LINE_PREFIX} 7f3a1b2c | Mara K. | human] `), body.trim());
});

test("collabLines: a multi-byte character is never cut in half", () => {
  const body = "😀".repeat(600);
  const lines = collabLines({ collabId: COLLAB_ID, from: "Mara K.", kind: "claude", text: body });
  assert.ok(lines.length > 1);
  for (const line of lines) {
    assert.ok(line.length <= MAX_LINE_CHARS);
    const last = line.charCodeAt(line.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), "line ends in the first half of a surrogate pair");
  }
  assert.equal(rebuild(lines), body);
});

test("collabLines: an escape sequence is not split at its backslash", () => {
  const body = `${"x".repeat(63)}\\u0041${"y".repeat(300)}`;
  const lines = collabLines({ collabId: "a-1", from: "X", kind: "claude", text: body, maxChars: 100 });
  assert.ok(lines.length > 1);
  for (const line of lines) assert.ok(!line.endsWith("\\"), `line ends on a lone backslash: ${line.slice(-5)}`);
  assert.ok(rebuild(lines, `${COLLAB_LINE_PREFIX} a | X | claude] `).includes("\\u0041"));
});

test("collabLines: an unsplittable line names the loss honestly", () => {
  // A budget so small that no honest part fits: splitting would leave noise, so the line is cut --
  // and then it has to say that the rest is GONE, not pretend to be complete.
  const lines = collabLines({ collabId: "a-1", from: "X", kind: "claude", text: "z".repeat(5000), maxChars: 60 });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].length <= 60, `line is ${lines[0].length} chars (limit 60)`);
  assert.ok(lines[0].startsWith(COLLAB_LINE_PREFIX));
  assert.match(lines[0], /Rest fehlt: 5000 Zeichen gesamt\]$/);
});

test("collabLines: an embedded newline cannot break the line framing", () => {
  // A raw newline would start a second stdout line WITHOUT the [kwcollab head -- the reader would
  // not see it as foreign data (and the harness would count it separately).
  const lines = collabLines({ collabId: "a-1", from: "X", kind: "claude", text: "erste\nzweite\r\n\tdritte" });
  assert.deepEqual(lines, ["[kwcollab a | X | claude] erste zweite dritte"]);
});

