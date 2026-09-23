import test from "node:test";
import assert from "node:assert/strict";

// KWOS_XID_ACCESS_TOKEN vor jedem Import setzen (s. relay-client.test.js) -- listen.js importiert
// transitiv relay-client.js -> config.js. Kein main()-Aufruf beim Import (Guard in listen.js).
process.env.KWOS_XID_ACCESS_TOKEN = "test-token";
const { formatLine, createLineWriter, forwardToWriter, MAX_LINE_CHARS, LINE_SPACING_MS } = await import("../server/listen.js");

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

// Review-Fund F3: der Grenzwert-Test oben war tautologisch -- er prueft die Implementierung gegen
// sich selbst und bleibt fuer JEDEN Wert von MAX_LINE_CHARS gruen. Damit fehlte die Verankerung
// gegen die tatsaechlich gemessene Harness-Grenze: setzt jemand MAX_LINE_CHARS auf 700, bleibt
// alles gruen, und der Harness kappt wieder -- samt Bild-Hinweis.
test("MAX_LINE_CHARS ist gegen die gemessene 500er-Grenze verankert (nicht frei waehlbar)", () => {
  assert.ok(MAX_LINE_CHARS <= 500, `MAX_LINE_CHARS=${MAX_LINE_CHARS} liegt nicht unter der gemessenen Grenze 500`);
  assert.ok(MAX_LINE_CHARS <= 480, `Reserve unter der 500er-Grenze nicht mehr eingehalten (MAX_LINE_CHARS=${MAX_LINE_CHARS})`);
});

test("Worst Case (langer Absender + Anhang) bleibt unter der gemessenen 500er-Grenze", () => {
  // from_session ist serverseitig auf 128 Zeichen begrenzt (relay/lib.js SESSION_RE), attachment_id
  // ist eine UUID -- das ist der laengste realistische Fall, nicht ein erfundener.
  const raw = JSON.stringify({
    from_session: "s".repeat(128),
    text: "v".repeat(4000),
    seq: 123456,
    attachment_id: "a".repeat(36),
  });
  const line = formatLine(raw);
  assert.ok(line.length < 500, `Zeile ist ${line.length} Zeichen lang`);
  // Der Bild-Hinweis ist der Grund fuer den ganzen Fix -- er muss auch im Worst Case ueberleben.
  assert.match(line, /attachment_id=/, line.slice(-120));
});

// Review-Fund F4: main() verdrahtet SSE-Frame -> formatLine -> Writer. Ohne Test auf dieser Naht
// laesst sich die Verdrahtung zurueckdrehen, ohne dass ein Test rot wird -- und der stille
// Totalverlust (A08..A12) waere zurueck.
test("Verdrahtung: SSE-Frames laufen ueber formatLine UND den Abstands-Writer", async () => {
  const written = [];
  const forward = forwardToWriter(createLineWriter({ write: (s) => written.push(s) }, { spacingMs: 20 }));
  forward(JSON.stringify({ from_session: "sess-abc", text: "hallo", seq: 1 }));
  forward(JSON.stringify({ from_session: "sess-abc", text: "zweite", seq: 2 }));
  assert.deepEqual(written, ["[sess-abc]: hallo\n"]);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(written, ["[sess-abc]: hallo\n", "[sess-abc]: zweite\n"]);
});

// ── Harness-Kappung (WI 11075502) ─────────────────────────────────────────────
// Claude Code kappt jede Monitor-Zeile bei 500 Zeichen (500 kommt vollstaendig an, 501 verliert
// ein Zeichen und bekommt "...(truncated)"). Zeilen, die dicht beieinander geschrieben werden,
// werden ausserdem zu EINER Notification gebuendelt und dann bei 3000 Zeichen gekappt. Belege:
// investigations/investigation-monitor-500-zeichen-11075502.md im litellm-Repo.
// Folge: die Zeile muss VOR dem Harness unter dem Limit bleiben -- sonst kappt der Harness, und
// zwar zuerst den Bild-Hinweis am Zeilenende (der genau den Abruf ermoeglicht).

test("lange Nachricht: Zeile bleibt unter dem Harness-Limit und nennt seq zum Nachholen", () => {
  const raw = JSON.stringify({ from_session: "sess-abc", text: "x".repeat(5000), seq: 42 });
  const line = formatLine(raw);
  assert.ok(line.length <= MAX_LINE_CHARS, `Zeile ist ${line.length} Zeichen lang (Limit ${MAX_LINE_CHARS})`);
  assert.ok(line.startsWith("[sess-abc]: xxx"), line.slice(0, 40));
  assert.match(line, /\[\+5000 Zeichen -- get_message\(seq=42\)\]$/);
});

test("Text genau am Limit bleibt unveraendert, ein Zeichen mehr erzeugt den Marker", () => {
  const prefix = "[sess-abc]: ";
  const atLimit = "y".repeat(MAX_LINE_CHARS - prefix.length);
  assert.equal(formatLine(JSON.stringify({ from_session: "sess-abc", text: atLimit, seq: 1 })), prefix + atLimit);

  const line = formatLine(JSON.stringify({ from_session: "sess-abc", text: atLimit + "y", seq: 1 }));
  assert.ok(line.length <= MAX_LINE_CHARS, `Zeile ist ${line.length} Zeichen lang`);
  assert.match(line, /get_message\(seq=1\)\]$/);
});

test("Bildhinweis ueberlebt eine lange Nachricht (Restrisiko aus WI 11075502)", () => {
  const raw = JSON.stringify({ from_session: "sess-abc", text: "z".repeat(5000), seq: 7, attachment_id: "att-9" });
  const line = formatLine(raw);
  assert.ok(line.length <= MAX_LINE_CHARS, `Zeile ist ${line.length} Zeichen lang`);
  assert.match(line, /attachment_id=att-9 -- mit get_attachment abrufbar\]$/);
  assert.match(line, /get_message\(seq=7\)/);
});

test("Nachricht ohne seq: Marker ohne get_message-Hinweis, kein 'seq=null'", () => {
  const line = formatLine(JSON.stringify({ from_session: "sess-abc", text: "w".repeat(900) }));
  assert.ok(line.length <= MAX_LINE_CHARS);
  assert.match(line, /\[\+900 Zeichen\]$/);
  assert.ok(!line.includes("get_message"), line);
});

test("pathologisch langer Absender + Anhang: Zeile ueberschreitet das Limit trotzdem nie", () => {
  const raw = JSON.stringify({
    from_session: "s".repeat(600), text: "v".repeat(600), seq: 1, attachment_id: "a".repeat(200),
  });
  const line = formatLine(raw);
  assert.ok(line.length <= MAX_LINE_CHARS, `Zeile ist ${line.length} Zeichen lang`);
});

test("nicht parsebare Rohdaten werden ebenfalls gekappt (gleiche Invariante)", () => {
  const line = formatLine("k".repeat(900));
  assert.ok(line.length <= MAX_LINE_CHARS, `Zeile ist ${line.length} Zeichen lang`);
});

// ── Zeilenabstand gegen die 3000-Zeichen-Buendelung (WI 11075502) ─────────────
// Gemessen: 12 Zeilen a 480 Zeichen ohne Abstand -> EINE Notification, A01..A06 komplett, A07
// halb, A08..A12 spurlos weg (ohne Marker, also nicht nachholbar). Dieselben 12 Zeilen mit 250 ms
// Abstand -> 12 eigene Notifications, alle vollstaendig. Der Abstand ist deshalb kein Feinschliff,
// sondern das, was den stillen Totalverlust verhindert.

test("einzelne Zeile wird ohne Verzoegerung geschrieben", () => {
  const written = [];
  createLineWriter({ write: (s) => written.push(s) }, { spacingMs: 250 })("nur eine");
  assert.deepEqual(written, ["nur eine\n"]);
});

test("Folgezeilen werden NICHT im Buendel geschrieben, sondern mit Abstand", async () => {
  const written = [];
  const write = createLineWriter({ write: (s) => written.push(s) }, { spacingMs: 20 });
  write("eins");
  write("zwei");
  write("drei");
  // Synchron ist nur die erste Zeile draussen -- genau das verhindert das Buendel.
  assert.deepEqual(written, ["eins\n"]);
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(written, ["eins\n", "zwei\n", "drei\n"]);
});

test("Reihenfolge bleibt erhalten, keine Zeile geht verloren", async () => {
  const written = [];
  const write = createLineWriter({ write: (s) => written.push(s) }, { spacingMs: 1 });
  const lines = Array.from({ length: 12 }, (_, i) => `z${i}`);
  for (const l of lines) write(l);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(written, lines.map((l) => `${l}\n`));
});

test("LINE_SPACING_MS liegt ueber dem gemessenen Buendelungsfenster (~200 ms)", () => {
  assert.ok(LINE_SPACING_MS > 200, `LINE_SPACING_MS=${LINE_SPACING_MS} liegt nicht ueber dem Messwert`);
});

test("eine werfende Schreiboperation verliert die Zeile nicht (kein stiller Verlust)", async () => {
  const written = [];
  let failNext = true;
  const write = createLineWriter(
    {
      write: (s) => {
        if (failNext) {
          failNext = false;
          throw new Error("EPIPE");
        }
        written.push(s);
      },
    },
    { spacingMs: 1 }
  );
  write("eins");
  write("zwei");
  await new Promise((r) => setTimeout(r, 100));
  // "eins" scheitert beim ersten Versuch, muss aber in der Queue bleiben und nachgeholt werden --
  // ein stiller Verlust waere genau das, was dieser Fix verhindern soll.
  assert.deepEqual(written, ["eins\n", "zwei\n"]);
});

// Review-Fund F8: beim Session-Ende bricht runSseReceiver ab und main() kehrt zurueck -- ohne
// Flush ginge die noch gepufferte Warteschlange verloren (im Backlog-Fall bis zu ~125 s
// Benachrichtigungen). flush() wartet, bis die Queue wirklich leer ist.
test("flush() wartet, bis alle gepufferten Zeilen geschrieben sind", async () => {
  const written = [];
  const write = createLineWriter({ write: (s) => written.push(s) }, { spacingMs: 20 });
  for (const l of ["a", "b", "c"]) write(l);
  assert.equal(written.length, 1); // nur die erste ist sofort draussen
  await write.flush();
  assert.deepEqual(written, ["a\n", "b\n", "c\n"]);
});

test("flush() ohne offene Zeilen loest sofort auf", async () => {
  const write = createLineWriter({ write: () => {} }, { spacingMs: 20 });
  await write.flush();
});

// Review-Fund (b): nach einem Schreibfehler wartete der Drain auf die NAECHSTE eingehende Zeile.
// Kommt keine mehr, steht die Warteschlange fuer immer -- und weil der Relay die Nachrichten beim
// Push schon als zugestellt markiert, ist sie dann die einzige Kopie. Der Drain plant sich deshalb
// selbst neu ein.
test("nach einem Schreibfehler wird von selbst erneut versucht (kein Stillstand)", async () => {
  const written = [];
  let failNext = true;
  const write = createLineWriter(
    {
      write: (s) => {
        if (failNext) {
          failNext = false;
          throw new Error("EPIPE");
        }
        written.push(s);
      },
    },
    { spacingMs: 20 }
  );
  write("eins");
  assert.deepEqual(written, [], "der erste Versuch scheitert erwartungsgemaess");
  // KEIN weiterer write()-Aufruf -- trotzdem muss die Zeile nachgeholt werden.
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(written, ["eins\n"]);
});

// Review-Restfund: flush() hing nur am laufenden Drain. Nach einem Schreibfehler ist der null,
// waehrend der Wiederholungs-Timer noch laeuft -- flush() loeste also sofort auf, obwohl die
// Warteschlange noch voll ist, und das Session-Ende haette sie verloren.
test("flush() wartet auch auf einen ausstehenden Wiederholungsversuch", async () => {
  const written = [];
  let failNext = true;
  const write = createLineWriter(
    {
      write: (s) => {
        if (failNext) {
          failNext = false;
          throw new Error("EPIPE");
        }
        written.push(s);
      },
    },
    { spacingMs: 20 }
  );
  write("eins");
  assert.deepEqual(written, []);
  await write.flush();
  assert.deepEqual(written, ["eins\n"], "flush() darf nicht aufloesen, solange die Queue voll ist");
});
