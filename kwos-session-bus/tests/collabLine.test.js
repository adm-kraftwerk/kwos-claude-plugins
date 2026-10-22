import test from "node:test";
import assert from "node:assert/strict";
import {
  collabLine, collabClosedLine, collabShortId, senderName, COLLAB_LINE_PREFIX,
  MONITOR_LINE_MAX, LINE_SAFETY,
} from "../server/collabLine.js";
import { frameToLine } from "../server/collab-listen.js";
import { MAX_LINE_CHARS } from "../server/listen.js";

// kwcollab: die Zeile(n), die im Verlauf landen (WI 11482928; geteilt statt gekappt seit WI 11536314).
//
// Diese Zeile ist die Vertrauensgrenze des Features in Textform: das Prompt-Fragment im
// litellm-Repo stuft genau die Zeilen mit diesem Praefix als FREMDDATEN ein. Wird das Format
// weich, sieht eine Nachricht von Mara aus wie eine des eigenen Nutzers -- und wird ausgefuehrt.
// Deshalb traegt JEDES Teil seinen eigenen Kopf: ein Teil ohne "[kwcollab" waere fuer das Fragment
// eine Zeile des eigenen Nutzers.

const COLLAB = "7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c";

/** Kopf und "(i/n) "-Zaehler abziehen: uebrig bleibt genau der Text, der in diesem Teil steht. */
const bodyOf = (line) => line.replace(/^\[kwcollab [^\]]*\] /, "").replace(/^\(\d+\/\d+\) /, "");

test("collabLine: Praefix, Kanal, seq, Absender und Art stehen in JEDER Zeile", () => {
  const lines = collabLine({
    collabId: COLLAB,
    seq: 7,
    from: "Mara K.",
    kind: "claude",
    text: "Befund: Proxy bricht nach 60 s ab.",
  });
  assert.deepEqual(lines, [`${COLLAB_LINE_PREFIX} 7f3a1b2c:7 | Mara K. | claude] Befund: Proxy bricht nach 60 s ab.`]);
  assert.ok(lines[0].startsWith("[kwcollab"), "muss mit dem Praefix beginnen, auf den das Prompt-Fragment zeigt");
});

test("collabLine: ohne seq bleibt der Kopf in der alten Form (die Zeile ist keine Nachricht)", () => {
  // Die Systemzeile "Kanal beendet" ist keine gespeicherte Nachricht: es gibt nichts zu benennen
  // und nichts nachzuholen. Das Feld fehlt dann ganz, statt ":undefined" zu heissen.
  const [line] = collabLine({ collabId: COLLAB, from: "Mara K.", kind: "claude", text: "t" });
  assert.equal(line, "[kwcollab 7f3a1b2c | Mara K. | claude] t");
});

test("collabLine: eine seq als ZAHLENSTRING wird gelesen -- die Adresse bleibt", () => {
  // Der Relay reicht die seq als Zahl ODER als String durch; seine festgeschriebene Fassung
  // erzwingt die Zahl mit Number(seq). Ohne DIESELBE Toleranz faellt die Adresse hier weg -- der
  // Leser haette dann keine Moeglichkeit mehr, eine Zeile nachzuholen, die er holen koennte.
  // Dieselbe Regel auf beiden Seiten ist der Punkt, nicht die Bequemlichkeit.
  const [line] = collabLine({ collabId: COLLAB, seq: "12", from: "Mara K.", kind: "claude", text: "t" });
  assert.equal(line, "[kwcollab 7f3a1b2c:12 | Mara K. | claude] t");
});

test("collabLine: eine unbrauchbare seq faellt weg -- kein ':NaN' und kein ':1e+21' im Kopf", () => {
  for (const bad of [null, undefined, 0, -1, "", "abc", 1.5, NaN, Infinity, 1e21, {}]) {
    const [line] = collabLine({ collabId: COLLAB, seq: bad, from: "Mara K.", kind: "claude", text: "t" });
    assert.equal(line, "[kwcollab 7f3a1b2c | Mara K. | claude] t", `seq=${String(bad)}`);
  }
});

test("collabLine: ein Mensch wird als Mensch gekennzeichnet", () => {
  const [line] = collabLine({ collabId: "abc-1", seq: 3, from: "Jonas B.", kind: "human", text: "2.100 gilt." });
  assert.match(line, /\| human\] 2\.100 gilt\.$/);
});

test("collabLine: unbekannte Art faellt auf claude zurueck, nie auf human", () => {
  // Ein Client, der "human" faelscht oder etwas Unbekanntes schickt, darf nie als Mensch gelten.
  for (const kind of ["bogus", "", null, undefined, "Human"]) {
    const [line] = collabLine({ collabId: "a-1", seq: 1, from: "X", kind, text: "t" });
    assert.match(line, /\| claude\]/);
  }
});

test("collabLine: ohne Text, aber mit Anhang nennt sie den Anhang statt leer zu enden", () => {
  const [line] = collabLine({
    collabId: "a-1", seq: 4, from: "Mara K.", kind: "claude", text: "",
    attachmentId: "11111111-1111-1111-1111-111111111111",
  });
  assert.match(line, /collab_get_attachment 11111111-1111-1111-1111-111111111111/);
});

test("collabLine: ein fehlender Absender wird nicht erfunden", () => {
  const [line] = collabLine({ collabId: "a-1", seq: 1, from: null, kind: "claude", text: "t" });
  assert.match(line, /\| \? \|/);
});

// ── Teilen statt kappen (WI 11536314) ────────────────────────────────────────────────────────
//
// Der Feldbefund: die Zeile landete ueber der 500er-Grenze, der Harness kappte ein ZWEITES Mal --
// am Zeilenende, wo der Marker stand. Der Empfaenger sah eine Nachricht, die vollstaendig aussah,
// und hatte keine Moeglichkeit, den Rest zu benennen. Diese Tests halten die drei Zusagen fest:
// jedes Teil im Budget, die Teile in Reihenfolge, und der Text geht nicht verloren.

test("collabLine: eine lange Nachricht kommt in nummerierten Teilen, jedes Teil im Budget", () => {
  const words = Array.from({ length: 200 }, (_, i) => `wort${i}`);
  const text = words.join(" ");
  const lines = collabLine({ collabId: COLLAB, seq: 42, from: "Mara K.", kind: "claude", text });

  assert.ok(lines.length > 1, "eine 200-Wort-Nachricht passt nicht in eine Zeile");
  lines.forEach((line, i) => {
    assert.ok(line.length <= MAX_LINE_CHARS, `Teil ${i + 1} ist ${line.length} Zeichen lang`);
    assert.ok(line.length <= MONITOR_LINE_MAX, `Teil ${i + 1} liegt ueber der gemessenen Harness-Grenze`);
    assert.ok(line.startsWith(COLLAB_LINE_PREFIX), `Teil ${i + 1} beginnt nicht mit dem Praefix -- das Fragment liest ihn dann als eigene Zeile`);
    assert.match(line, new RegExp(`^\\[kwcollab 7f3a1b2c:42 \\| Mara K\\. \\| claude\\] \\(${i + 1}/${lines.length}\\) `));
  });

  // DER TEXT GEHT NICHT VERLOREN: an den Nahtstellen faellt genau das eine Trennzeichen weg, also
  // setzt ein Leerzeichen beim Zusammensetzen den Originaltext wieder her.
  assert.equal(lines.map(bodyOf).join(" "), text);
});

test("collabLine: eine Nachricht, die genau ins Budget passt, bleibt EINE Zeile", () => {
  const head = `[kwcollab 7f3a1b2c:5 | X | claude] `;
  const budget = MONITOR_LINE_MAX - head.length - LINE_SAFETY;
  const fits = "a".repeat(budget);
  assert.deepEqual(
    collabLine({ collabId: COLLAB, seq: 5, from: "X", kind: "claude", text: fits }),
    [`${head}${fits}`],
    "genau das Budget passt in EINE Zeile -- ohne Zaehler, denn es gibt nichts zu zaehlen",
  );

  // Ein Zeichen mehr heisst: teilen. Und der Text bleibt vollstaendig (ein Wort ohne Leerzeichen
  // wird hart geschnitten -- dabei faellt kein Zeichen weg, der Marker wird abgezogen).
  const over = fits + "a";
  const lines = collabLine({ collabId: COLLAB, seq: 5, from: "X", kind: "claude", text: over });
  assert.ok(lines.length > 1, "ein Zeichen ueber dem Budget muss geteilt werden");
  for (const line of lines) assert.ok(line.length <= MAX_LINE_CHARS, `Zeile ist ${line.length} Zeichen lang`);
  assert.equal(lines.map(bodyOf).join("").replace(/…\[\+\d+ Zeichen\]/g, ""), over);
});

test("collabLine: der '(i/n) '-Zaehler zaehlt gegen das Budget", () => {
  // Genau der Fehler, der WI 11536314 ausgeloest hat: das Budget ohne den Zaehler rechnen und ihn
  // dann davorschreiben. Die Zeile landet dann ueber der Grenze und der Harness kappt sie.
  // Hier: so viele Teile, dass der Zaehler zweistellig wird -- die breiteste Form.
  const text = "wort ".repeat(1000).trim();
  const lines = collabLine({ collabId: COLLAB, seq: 9, from: "Mara K.", kind: "claude", text });
  assert.ok(lines.length >= 10, `zu wenige Teile fuer den zweistelligen Zaehler: ${lines.length}`);
  for (const line of lines) {
    assert.ok(line.length <= MAX_LINE_CHARS, `Zeile mit Zaehler ist ${line.length} Zeichen lang`);
    // Der Text eines Teils passt genau in "Budget minus Kopf minus Zaehler".
    const head = line.match(/^\[kwcollab [^\]]*\] /)[0];
    const counter = line.match(/^\[kwcollab [^\]]*\] (\(\d+\/\d+\) )/)[1];
    assert.ok(bodyOf(line).length <= MAX_LINE_CHARS - head.length - counter.length,
      `Textteil zu lang: ${bodyOf(line).length}`);
  }
});

test("collabLine: ein einzelnes ueberlanges Wort wird hart geschnitten, der Marker UEBERLEBT", () => {
  // Der gemeldete Defekt in Reinform: ein Wort ohne Leerzeichen. Der Marker wurde frueher NACH dem
  // Schnitt angehaengt und fiel damit selbst weg. Jetzt ist er im Budget reserviert.
  const word = "x".repeat(2000);
  const lines = collabLine({ collabId: COLLAB, seq: 11, from: "Mara K.", kind: "claude", text: word });
  assert.ok(lines.length > 1);
  for (const line of lines) {
    assert.ok(line.length <= MAX_LINE_CHARS, `Zeile ist ${line.length} Zeichen lang`);
  }
  // Jedes Teil ausser dem letzten sagt, wie viel an DIESER Stelle fehlt -- und der Marker ist da,
  // nicht weggekappt.
  for (const line of lines.slice(0, -1)) {
    assert.match(line, /…\[\+\d+ Zeichen\]$/, `Marker fehlt oder ist gekappt: ${line.slice(-40)}`);
  }
  assert.equal(lines[lines.length - 1].endsWith("Zeichen]"), false, "das letzte Teil hat nichts mehr nachzutragen");
  // Und die Zeichen des Wortes sind alle noch da (Marker abgezogen).
  const rebuilt = lines.map(bodyOf).map((p) => p.replace(/…\[\+\d+ Zeichen\]$/, "")).join("");
  assert.equal(rebuilt, word);
});

test("collabLine: der Worst Case (128 Zeichen Absendername) rechnet sich aus dem ECHTEN Kopf", () => {
  // Der Anzeigename kommt vom Relay und ist bis 128 Zeichen lang. Ein festes Textbudget waere fuer
  // diesen Namen zu gross -- genau dort ginge der Rest verloren. Hier steht die Arithmetik.
  const name = "M".repeat(128);
  const head = `[kwcollab 7f3a1b2c:7 | ${name} | claude] `;
  assert.equal(head.length, 162, "Kopf-Arithmetik: 10 + 8 + 2 + 3 + 128 + 3 + 6 + 2");
  assert.equal(MONITOR_LINE_MAX - head.length - LINE_SAFETY, 318, "Textbudget im Worst Case");

  const lines = collabLine({ collabId: COLLAB, seq: 7, from: name, kind: "claude", text: "z".repeat(5000) });
  assert.ok(lines.length > 1);
  for (const line of lines) {
    assert.ok(line.length <= MAX_LINE_CHARS, `Zeile ist ${line.length} Zeichen lang (Grenze ${MAX_LINE_CHARS})`);
  }
  // Kein Teil ist leer und der Text steht vollstaendig darin. Ein Wort ohne Leerzeichen wird hart
  // geschnitten -- dabei faellt KEIN Zeichen weg (anders als beim Wortgrenzen-Schnitt, der genau
  // das eine Trennzeichen entfernt), also setzt die leere Verkettung das Wort wieder her.
  assert.equal(lines.map(bodyOf).join("").replace(/…\[\+\d+ Zeichen\]/g, ""), "z".repeat(5000));
});

test("collabLine: der Worst Case mit dem ABSOLUT breitesten Kopf bleibt im Budget", () => {
  // 128 Zeichen Name, sechsstellige seq, laengste Art ("system" statt "claude") -- alles, was der
  // Kopf an Breite aufnehmen kann, in EINER Zeile.
  const name = "M".repeat(128);
  const head = `[kwcollab 7f3a1b2c:999999 | ${name} | system] `;
  assert.equal(head.length, 167, "10 + 8 + 7 + 3 + 128 + 3 + 6 + 2");
  const lines = collabLine({ collabId: COLLAB, seq: 999999, from: name, kind: "system", text: "wort ".repeat(200) });
  for (const line of lines) {
    assert.ok(line.length <= MAX_LINE_CHARS, `Zeile ist ${line.length} Zeichen lang`);
    assert.match(line, /^\[kwcollab 7f3a1b2c:999999 \|/);
  }
});

test("collabLine: auch bei engem Budget bleibt jedes Teil im Budget (Zaehler-Festpunkt)", () => {
  // Der schmale Fall: langer Kopf UND kleiner cap. Hier waechst der Zaehler, waehrend das Budget
  // schrumpft -- genau die Iteration, die den Zaehler einrechnet. Kein Teil darf die Grenze reissen.
  const name = "M".repeat(128);
  const text = "wort ".repeat(200).trim();
  const lines = collabLine({ collabId: COLLAB, seq: 999999, from: name, kind: "system", text, cap: 200, safety: 10 });
  assert.ok(lines.length > 1);
  for (const line of lines) {
    assert.ok(line.length <= 200, `Zeile ist ${line.length} Zeichen lang (cap 200)`);
    assert.match(line, /\(\d+\/\d+\) /);
  }
  assert.equal(lines.map(bodyOf).join(" "), text);
});

// ── Kanal-Ende, Kurz-ID, Absendername ────────────────────────────────────────────────────────
test("collabClosedLine: sagt, dass der Kanal weg ist -- und traegt KEINE seq", () => {
  const line = collabClosedLine(COLLAB);
  assert.match(line, /^\[kwcollab 7f3a1b2c \| system\]/);
  assert.match(line, /beendet/i);
  assert.ok(!/:\d+ \|/.test(line), "die Systemzeile ist keine Nachricht und hat keine seq");
});

test("collabShortId: die erste UUID-Gruppe reicht, um zwei Kanaele zu unterscheiden", () => {
  assert.equal(collabShortId(COLLAB), "7f3a1b2c");
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
test("frameToLine: eine fremde Nachricht wird zu einer Kanal-Zeile mit ihrer seq", () => {
  const raw = JSON.stringify({
    seq: 7, collab_id: COLLAB, from_session: "s-mara",
    from_subject: "u-mara", author_kind: "claude", text: "12 Requests, alle 200.",
  });
  const lines = frameToLine(raw, {
    members: [{ subject: "u-mara", display_name: "Mara K." }], selfSessionId: "s-me",
  });
  assert.deepEqual(lines, ["[kwcollab 7f3a1b2c:7 | Mara K. | claude] 12 Requests, alle 200."]);
});

test("frameToLine: eine lange Nachricht wird zu MEHREREN Zeilen, in Reihenfolge", () => {
  const text = "wort ".repeat(300).trim();
  const raw = JSON.stringify({
    seq: 21, collab_id: COLLAB, from_session: "s-mara",
    from_subject: "u-mara", author_kind: "claude", text,
  });
  const lines = frameToLine(raw, { members: [{ subject: "u-mara", display_name: "Mara K." }], selfSessionId: "s-me" });
  assert.ok(lines.length > 1);
  assert.match(lines[0], /^\[kwcollab 7f3a1b2c:21 \| Mara K\. \| claude\] \(1\//);
  assert.match(lines[1], /^\[kwcollab 7f3a1b2c:21 \| Mara K\. \| claude\] \(2\//);
  assert.equal(lines.map(bodyOf).join(" "), text);
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
  assert.match(lines.join("\n"), /Fasse die wichtigsten Schritte zusammen\./);
  assert.match(lines.join("\n"), /\| human\]/);
});

test("frameToLine: das Kanal-Ende ist eine Systemzeile ohne seq, kein leerer Text", () => {
  const lines = frameToLine(JSON.stringify({ collab_id: "7f3a1b2c-9d4e" }), { selfSessionId: "s-me" });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[kwcollab 7f3a1b2c \| system\]/);
});

test("frameToLine: unlesbare Frames erzeugen keine erfundene Zeile", () => {
  assert.equal(frameToLine("kein json", {}), null);
  assert.equal(frameToLine("null", {}), null);
  assert.equal(frameToLine("\"nur ein string\"", {}), null);
});
