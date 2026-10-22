import test from "node:test";
import assert from "node:assert/strict";
import { installFetchMock } from "./helpers/fetch-mock.js";

// kwcollab-Client (WI 11482928): welche Session in welchem Kanal ist, und was ein 409 bedeutet.
//
// KWOS_XID_ACCESS_TOKEN MUSS vor dem Laden von config.js gesetzt sein (s. relay-client.test.js).
process.env.KWOS_XID_ACCESS_TOKEN = "test-token";
process.env.KWOS_CLIENT_ID = "test-client";
const { config } = await import("../server/config.js");
const collab = await import("../server/collab.js");

const jsonResponse = (body, status = 200) =>
  Promise.resolve({
    ok: status < 400,
    status,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify(body),
    json: async () => body,
  });

const collabRow = (over = {}) => ({
  collab_id: "7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c",
  workitem: "11482928",
  title: "Gateway: 502 nur auf einem Rechner",
  my_status: "joined",
  my_role: "member",
  members: [{ subject: "u-mara", display_name: "Mara K.", session_id: config.sessionId, status: "joined" }],
  ...over,
});

test("myJoinedCollabs: nimmt nur Kanaele, in denen GENAU DIESE Session sitzt", async () => {
  // Eine Person kann in mehreren Kanaelen sein, und ihre andere Session kann im selben sein --
  // unterschieden wird ueber die session_id der Mitgliedszeile, nicht ueber den Login.
  const mock = installFetchMock(() =>
    jsonResponse({
      collabs: [
        collabRow(),
        collabRow({ collab_id: "aaaaaaaa-0000-0000-0000-000000000000", members: [{ subject: "u-jonas", session_id: "eine-andere-session", status: "joined" }] }),
        collabRow({ collab_id: "bbbbbbbb-0000-0000-0000-000000000000", my_status: "invited" }),
      ],
    })
  );
  try {
    const joined = await collab.myJoinedCollabs();
    assert.equal(joined.length, 1);
    assert.equal(joined[0].collab_id, "7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c");
  } finally { mock.restore(); }
});

test("myInvitations: die offenen Einladungen dieses Logins", async () => {
  const mock = installFetchMock(() =>
    jsonResponse({ collabs: [collabRow(), collabRow({ collab_id: "bbbbbbbb-0000-0000-0000-000000000000", my_status: "invited" })] })
  );
  try {
    const invites = await collab.myInvitations();
    assert.deepEqual(invites.map((c) => c.collab_id), ["bbbbbbbb-0000-0000-0000-000000000000"]);
  } finally { mock.restore(); }
});

test("resolveCollab: genau ein Kanal -> keine collab_id noetig", async () => {
  const mock = installFetchMock(() => jsonResponse({ collabs: [collabRow()] }));
  try {
    const c = await collab.resolveCollab();
    assert.equal(c.workitem, "11482928");
  } finally { mock.restore(); }
});

test("resolveCollab: MEHRERE Kanaele -> Fehler, der sie alle nennt (kein stiller erster Treffer)", async () => {
  // Der stille Griff zum ersten Kanal wuerde in den falschen Kanal schreiben -- das ist der
  // Fehler, den dieser Test verhindert.
  const mock = installFetchMock(() =>
    jsonResponse({
      collabs: [
        collabRow(),
        collabRow({ collab_id: "cccccccc-0000-0000-0000-000000000000", workitem: "11499999" }),
      ],
    })
  );
  try {
    await assert.rejects(() => collab.resolveCollab(), (err) => {
      assert.match(err.message, /mehreren Collabs/);
      assert.match(err.message, /11482928/);
      assert.match(err.message, /11499999/);
      return true;
    });
    const chosen = await collab.resolveCollab("cccccccc-0000-0000-0000-000000000000");
    assert.equal(chosen.workitem, "11499999");
  } finally { mock.restore(); }
});

test("resolveCollab: kein Kanal -> sagt, dass der Beitritt in der Oberflaeche passiert", async () => {
  const mock = installFetchMock(() => jsonResponse({ collabs: [] }));
  try {
    await assert.rejects(() => collab.resolveCollab(), (err) => {
      assert.match(err.message, /in keinem Collab/);
      assert.match(err.message, /Sitzungsliste|Fenster/);
      return true;
    });
  } finally { mock.restore(); }
});

test("resolveCollab: ein Kanal, aus dem diese Session raus ist, zaehlt nicht", async () => {
  const mock = installFetchMock(() =>
    jsonResponse({ collabs: [collabRow({ members: [{ subject: "u-mara", session_id: config.sessionId, status: "kicked" }] })] })
  );
  try {
    await assert.rejects(() => collab.resolveCollab(), /in keinem Collab/);
  } finally { mock.restore(); }
});

test("sendCollabMessage: schickt als claude MIT der eigenen session_id", async () => {
  const mock = installFetchMock(() => jsonResponse({ message: { seq: 3 }, claude_streak: 4 }, 201));
  try {
    const out = await collab.sendCollabMessage("7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c", "Befund");
    assert.equal(out.claude_streak, 4);
    const body = JSON.parse(mock.calls[0].init.body);
    assert.equal(body.author_kind, "claude");
    assert.equal(body.session_id, config.sessionId);
    assert.match(mock.calls[0].url, /\/v1\/collabs\/7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c\/messages$/);
  } finally { mock.restore(); }
});

test("clampSummary: was der Relay nicht annimmt, kostet die Kurzform und nie die Nachricht", () => {
  // Ein Modell schreibt zwei Saetze oder einen sehr langen: der Relay wuerde mit 400 antworten, und
  // die GANZE Nachricht fiele mit. Also wird hier gefaltet, was nicht als eine Zeile durchgeht.
  assert.equal(collab.clampSummary("  Diff in drei Dateien, tsc gruen.  "), "Diff in drei Dateien, tsc gruen.");
  assert.equal(collab.clampSummary("erste Zeile\nzweite Zeile"), "erste Zeile zweite Zeile");
  assert.equal(collab.clampSummary(""), null);
  assert.equal(collab.clampSummary("   \n  "), null);
  assert.equal(collab.clampSummary(undefined), null);
  assert.equal(collab.clampSummary(42), null);
  const long = collab.clampSummary(`${"Wort ".repeat(200)}Ende`);
  assert.ok(long.length <= collab.SUMMARY_MAX, `zu lang: ${long.length}`);
  assert.ok(long.endsWith("…"));
  assert.ok(!long.includes("\n"));
});

test("sendCollabMessage: die Kurzform faehrt nur mit, wenn es eine gibt (WI 11538037)", async () => {
  const mock = installFetchMock(() => jsonResponse({ message: { seq: 3 }, claude_streak: 1 }, 201));
  try {
    await collab.sendCollabMessage("7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c", "Diff im Anhang", null, false,
      "  Diff in drei Dateien, tsc gruen.  ");
    assert.equal(JSON.parse(mock.calls[0].init.body).summary, "Diff in drei Dateien, tsc gruen.");
    // Mehrzeilig oder zu lang: was hinausgeht, ist EINE Zeile innerhalb der Grenze des Relays.
    await collab.sendCollabMessage("7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c", "Diff im Anhang", null, false,
      `Befund im Anhang.\n${"Wort ".repeat(120)}`);
    const sent = JSON.parse(mock.calls[1].init.body).summary;
    assert.ok(!sent.includes("\n"));
    assert.ok(sent.length <= collab.SUMMARY_MAX);
    // Ohne Kurzform geht das Feld NICHT hinaus: der Relay faellt dann auf die erste Textzeile
    // zurueck, und ein leerer String waere dort ein 400.
    await collab.sendCollabMessage("7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c", "kurz");
    assert.equal("summary" in JSON.parse(mock.calls[2].init.body), false);
    await collab.sendCollabMessage("7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c", "kurz", null, false, "   ");
    assert.equal("summary" in JSON.parse(mock.calls[3].init.body), false);
  } finally { mock.restore(); }
});

test("sendCollabMessage: die Pause (409) wird als Satz weitergereicht, nicht als Retry", async () => {
  const mock = installFetchMock(() =>
    jsonResponse({ error: "paused after 10 claude messages without a human" }, 409)
  );
  try {
    await assert.rejects(() => collab.sendCollabMessage("7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c", "nochmal"), (err) => {
      assert.match(err.message, /409/);
      assert.match(err.message, /paused after 10/);
      return true;
    });
  } finally { mock.restore(); }
});

test("acquireLease: ein Abschnittskonflikt nennt den Halter im Fehler", async () => {
  const mock = installFetchMock(() =>
    jsonResponse({ error: "section held by someone else", holder: "u-jonas", expires_at: "2026-10-15T12:00:00Z" }, 409)
  );
  try {
    await assert.rejects(
      () => collab.acquireLease("7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c", { subjectId: "s", section: "## Preisblatt" }),
      (err) => {
        assert.match(err.message, /gehalten von u-jonas/);
        return true;
      }
    );
  } finally { mock.restore(); }
});

test("acquireLease: schickt Abschnitt and TTL, ohne exclusive zu setzen (Server-Default)", async () => {
  const mock = installFetchMock(() => jsonResponse({ lease: { lease_id: "l1" } }, 201));
  try {
    await collab.acquireLease("7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c", {
      subjectId: "11111111-1111-1111-1111-111111111111", section: "## Preisblatt", ttlSec: 600, reason: "schreibe",
    });
    const body = JSON.parse(mock.calls[0].init.body);
    assert.deepEqual(body, {
      subject_id: "11111111-1111-1111-1111-111111111111",
      section: "## Preisblatt",
      ttl_sec: 600,
      reason: "schreibe",
    });
  } finally { mock.restore(); }
});

test("acquireLease: der Aufrufer BENENNT den Gegenstand, statt einen zu suchen", async () => {
  // Feldmeldung 2026-10-20: der Agent konnte einen Gegenstand nicht anlegen, und der Mensch, den
  // er danach fragte, hatte dafuer keinen Knopf. Wer in ein Dokument schreibt, weiss welches es
  // ist -- `subject_kind` + `subject_ref` gehen so hinaus, der Relay legt die Zeile an.
  const mock = installFetchMock(() => jsonResponse({ lease: { lease_id: "l1", section: "## Preisblatt" } }, 201));
  try {
    await collab.acquireLease("7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c", {
      subject: { kind: "file", ref: "kwterm/node/src/agent.ts", title: "agent.ts" },
      section: "## Preisblatt",
    });
    const body = JSON.parse(mock.calls[0].init.body);
    assert.deepEqual(body, {
      subject: { kind: "file", ref: "kwterm/node/src/agent.ts", title: "agent.ts" },
      section: "## Preisblatt",
    });
    assert.equal("subject_id" in body, false, "ein leerer subject_id ging mit hinaus");
  } finally { mock.restore(); }
});

test("sendCollabMessage: die eigene Menschen-Zeile wird gemerkt, sonst nichts", async () => {
  const { takeOwnHumanLine, forgetOwnHumanLines } = await import("../server/ownHumanLines.js");
  forgetOwnHumanLines();
  const mock = installFetchMock(() => jsonResponse({ message: { seq: 3 }, claude_streak: 0 }, 201));
  try {
    // Als AGENT geschrieben: die wirft der Empfang ohnehin ueber `from_session` weg.
    await collab.sendCollabMessage("7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c", "Befund");
    assert.equal(takeOwnHumanLine(3), false, "eine Agenten-Zeile wurde gemerkt");

    // Als MENSCH weitergereicht: genau die kaeme sonst als Monitor-Zeile zurueck.
    await collab.sendCollabMessage("7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c", "Frage von Steffen", null, true);
    assert.equal(takeOwnHumanLine(3), true, "die eigene Menschen-Zeile wurde nicht gemerkt");
  } finally { mock.restore(); }
});

test("releaseLease: DELETE auf die Lease-URL", async () => {
  const mock = installFetchMock(() => Promise.resolve({ ok: true, status: 204, headers: { get: () => null } }));
  try {
    await collab.releaseLease("7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c", "l1");
    assert.equal(mock.calls[0].init.method, "DELETE");
    assert.match(mock.calls[0].url, /\/leases\/l1$/);
  } finally { mock.restore(); }
});

test("getCollabAttachment: Bilder bleiben Bilder, Text bleibt Text", async () => {
  const bytes = Buffer.from("diff --git a/x b/x");
  const mock = installFetchMock(() =>
    Promise.resolve({
      ok: true, status: 200,
      headers: { get: () => "text/x-diff" },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    })
  );
  try {
    const out = await collab.getCollabAttachment("7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c", "aaaaaaaa-1111-1111-1111-111111111111");
    assert.equal(out.mimeType, "text/x-diff");
    assert.equal(Buffer.from(out.data, "base64").toString(), "diff --git a/x b/x");
  } finally { mock.restore(); }
});

test("collabEventsUrl: der Kanal hat seinen eigenen SSE-Pfad", () => {
  assert.equal(
    collab.collabEventsUrl("7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c"),
    `${config.relayUrl}/v1/collabs/7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c/events`
  );
});

// ── Beitreten, Ablehnen, Abkoppeln ────────────────────────────────────────────────────────────
// Das Annehmen geht NUR von der Sitzung selbst: der Relay prueft, dass die session_id dem Aufrufer
// gehoert (relay/server.js::ownedSession), und niemand sonst kennt die Claude-Code-Session-ID.
test("acceptCollab: schickt die EIGENE session_id mit", async () => {
  const mock = installFetchMock(() => jsonResponse({ me: { status: "joined" } }, 200));
  try {
    await collab.acceptCollab("7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c");
    const body = JSON.parse(mock.calls[0].init.body);
    assert.equal(body.session_id, config.sessionId);
    assert.match(mock.calls[0].url, /\/v1\/collabs\/7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c\/accept$/);
  } finally { mock.restore(); }
});

test("acceptCollab: ein fehlendes Sichtrecht kommt als Satz zurueck, nicht als leerer Erfolg", async () => {
  const mock = installFetchMock(() => jsonResponse({ error: "you cannot see this workitem" }, 403));
  try {
    await assert.rejects(() => collab.acceptCollab("c-1"), /you cannot see this workitem/);
  } finally { mock.restore(); }
});

test("declineCollab: POST ohne Rumpf auf die decline-Route", async () => {
  const mock = installFetchMock(() => jsonResponse({ declined: true }, 200));
  try {
    await collab.declineCollab("7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c");
    assert.equal(mock.calls[0].init.method, "POST");
    assert.match(mock.calls[0].url, /\/decline$/);
  } finally { mock.restore(); }
});

test("leaveCollab: ohne Zusammenfassung kein Rumpf-Feld, mit ihr schon", async () => {
  const mock = installFetchMock(() => jsonResponse({ left: true }, 200));
  try {
    await collab.leaveCollab("c-1");
    assert.equal(mock.calls[0].init.body, undefined);
    await collab.leaveCollab("c-1", "Befund steht im Workitem.");
    assert.equal(JSON.parse(mock.calls[1].init.body).summary, "Befund steht im Workitem.");
  } finally { mock.restore(); }
});

test("config.collab: die gestartete Sitzung kennt ihr Ziel, eine andere nicht", async () => {
  // Der Launcher/die Oberflaeche setzt KWOS_COLLAB nur, wenn die Sitzung AUS einer Einladung
  // entsteht -- der Wert ist damit die eine Angabe, aus der der Beitritt beim Start folgt.
  const { config: fresh } = await import("../server/config.js");
  assert.equal(fresh.collab, null, "ohne KWOS_COLLAB kein Ziel");
});

test("der Monitor-Timer haelt den Prozess nicht am Leben (Review-Fund Kai, 2026-10-16)", async () => {
  // Ein Timer, der NICHT `unref`'t ist, haelt den Prozess nach dem Ende der Sitzung am Leben -- das
  // offene stdin haelt ihn schon, solange die Sitzung laeuft, also entscheidet der Timer nur noch,
  // was danach passiert. Der Verwaiste fragt dann weiter alle 15 s beim Relay nach den Kanaelen
  // einer Sitzung, in der niemand mehr ist. Am Schwester-Timer in `index.js` gemessen: 47 ms bis
  // zum Prozessende mit unref, ohne ihn noch nach 10 s am Leben.
  //
  // Als QUELLTEXT-Pruefung, weil ein laufender Timer in einem Test nicht zu beobachten ist. Die
  // Zusicherung ist genau: jeder lange Timer dieses Prozesses ist unref't.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../server/collab-listen.js", import.meta.url), "utf8");
  assert.match(src, /watch\.unref\(\)/, "der Nachlauf-Timer (refreshSessionId) muss unref't sein");
  assert.match(src, /pollTimer\.unref\(\)/, "der Abfragetakt muss unref't sein");
});

test("nach einem Session-Wechsel nimmt der Monitor seine Kanaele neu an", async () => {
  // `/clear` und `--resume` geben eine neue Session-ID aus; die Mitgliedszeile im Relay nennt aber
  // die ALTE, und `myJoinedCollabs` filtert genau darauf -- ohne neues accept ist der Kanal fuer den
  // Client weg (jedes Werkzeug verweigert, der Monitor laesst seine Stroeme fallen). Review-Fund
  // Kai 2026-10-16; die Relay-Haelfte (das zweite accept BEWEGT die Zeile) liegt im LiteLLM-Repo.
  //
  // Als QUELLTEXT-Pruefung, wie die Timer-Zusicherung darueber: der Nachlauf ist nur mit einem
  // echten Marker-Wechsel und einem Relay zu beobachten. Geprueft wird die REIHENFOLGE, denn genau
  // daran haengt die Wirkung -- `closeAll()` leert die Liste, aus der die IDs kommen.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../server/collab-listen.js", import.meta.url), "utf8");
  // Die Bedingung ist seit 2026-10-19 (WI 11506447) der EIGENE letzte Stand und nicht mehr das
  // "changed" der gemeinsamen Antwort: Relay- und Kanal-Pfad laufen im selben Prozess und lesen
  // denselben Marker, also bekaeme der zweite "nichts geaendert" zu hoeren, waehrend sein Strom noch
  // auf der alten ID sitzt -- und mit ihm verloere er das erneute accept unten.
  const start = src.indexOf("if (config.sessionId === boundId) return;");
  assert.ok(start > 0, "der Nachlauf-Zweig ist nicht mehr auffindbar -- dann prueft dieser Fall nichts");
  assert.match(src, /let boundId = config\.sessionId;/,
    "der eigene letzte Stand muss VOR dem Timer stehen");
  const tail = src.slice(start, src.indexOf("}, config.sessionIdCheckMs)"));
  const capture = tail.indexOf("const was = ");
  const close = tail.indexOf("closeAll()");
  const accept = tail.indexOf("collab.acceptCollab(id)");
  assert.ok(capture > 0 && close > capture, "die Kanal-IDs muessen VOR closeAll() gemerkt werden");
  assert.ok(accept > close, "das erneute accept gehoert hinter closeAll()");
  // Und nur die eigenen Kanaele: niemals "alles, wo mein Login drin ist" (ein zweites Fenster kann
  // im selben Kanal sein -- ein accept von hier zoege ihm die Mitgliedschaft weg).
  assert.match(tail, /for \(const id of was\)/, "erneut angenommen wird nur, was dieser Monitor offen hatte");
  // Die Menge muss aber vollstaendig sein: `open` allein verpasst den Kanal, der gerade erst
  // beigetreten ist und dessen Strom noch nicht steht (der Poll oeffnet ihn erst im naechsten Takt).
  // Ein /clear in diesem Fenster haette den Kanal still verloren -- nach dem Wechsel nennt die
  // Mitgliedszeile die alte ID, also findet der naechste Poll gar keinen Kanal mehr.
  assert.match(tail, /const was = \[\.\.\.new Set\(\[\.\.\.open\.keys\(\), \.\.\.lastJoined\]\)\]/,
    "die Menge muss die offenen Stroeme UND die zuletzt gemeldeten Kanaele umfassen");
  // Kein Sammel-accept: der Aufruf (nicht das Wort -- der Kommentar nennt die Funktion) darf hier
  // nicht stehen.
  assert.ok(!/collab\.myJoinedCollabs\(/.test(tail), "kein Sammel-accept ueber alle Kanaele des Logins");
});

// Der Ring entscheidet den Kanal (Review-Fund 2026-10-16): ohne dieses Gate traegt das Plugin den
// EMPFANGSPFAD in jede --kwremote-Sitzung der Flotte -- ein Poll gegen den Relay im 15-s-Takt fuer
// einen Kanal, den keine Oberflaeche anbietet. Und das Prompt-Fragment, das "[kwcollab ...]"-Zeilen
// als FREMDDATEN kennzeichnet, haengt der Launcher unter DEMSELBEN Schalter an: ausserhalb des
// Rings kaemen Zeilen eines fremden Agenten ohne diese Rahmung an.
test("collabReleased: dieselben Schreibweisen wie der Launcher, NO schlaegt alles", async () => {
  const { collabReleased } = await import("../server/collab-listen.js");
  // Der Launcher akzeptiert 1|true|yes (getrimmt, case-insensitiv) und exportiert normalisiert
  // 1/0. Dieselbe Regel hier zu lesen heisst: ein von Hand gesetztes Wort verhaelt sich wie eine
  // Launcher-Antwort, statt einen Launcher zu brauchen.
  for (const v of ["1", "true", "yes", "TRUE", "Yes", " 1 "]) {
    assert.equal(collabReleased({ KWOS_COLLAB_CANARY: v }), true, JSON.stringify(v));
  }
  // Alles andere ist AUS -- auch ungesetzt: der Launcher im Feld exportiert die Variable noch
  // nicht, und ein Feature, das sich selbst einschaltet, ist keine Freigabe.
  for (const env of [{}, { KWOS_COLLAB_CANARY: "" }, { KWOS_COLLAB_CANARY: "0" },
    { KWOS_COLLAB_CANARY: "no" }, { KWOS_COLLAB_CANARY: "canary" }]) {
    assert.equal(collabReleased(env), false, JSON.stringify(env));
  }
  // Kein Environment heisst auch kein Ja -- ABER nur das LEERE: ohne Argument greift der
  // Default-Parameter, und der liest process.env. Auf einer Canary-Maschine steht die Variable
  // dort, und die Suite war damit rot, ohne dass der Code sich geaendert haette (gemessen
  // 2026-10-19 auf dem Spezimen). Deshalb wird der Default-Pfad hier ausdruecklich mit leerer
  // Umgebung geprueft statt mit "undefined" und einem Rechner, der zufaellig freigegeben ist.
  const saved = { ...process.env };
  try {
    for (const k of ["KWOS_COLLAB_CANARY", "KWOS_NO_COLLAB"]) delete process.env[k];
    assert.equal(collabReleased(undefined), false, "leere Umgebung ist auch kein Ja");
  } finally {
    for (const k of ["KWOS_COLLAB_CANARY", "KWOS_NO_COLLAB"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  // KWOS_NO_COLLAB schlaegt alles -- und zaehlt wie in der Shell als "nicht leer", also auch ein
  // einzelnes Leerzeichen.
  assert.equal(collabReleased({ KWOS_COLLAB_CANARY: "1", KWOS_NO_COLLAB: "1" }), false);
  assert.equal(collabReleased({ KWOS_COLLAB_CANARY: "1", KWOS_NO_COLLAB: " " }), false);
  assert.equal(collabReleased({ KWOS_COLLAB_CANARY: "0", KWOS_NO_COLLAB: "" }), false);
});

// ── NUR EINE REMOTE-SITZUNG BEKOMMT DIE REMOTE-WERKZEUGE ──────────────────────────────────────
// Befund 2026-10-19 (Luca): seit dem Kanal-Gate haengt das Plugin an JEDER freigegebenen Sitzung,
// also auch ohne --kwremote -- und `ask_remote` fragte dann per Push und blockierte bis zu 9,5
// Minuten, waehrend der Mensch am Terminal sass und die PWA gar nicht offen hatte. Ein Name in der
// Werkzeugliste ist ein Versprechen; dieses wird hier nicht mehr gegeben (und die Handlung darunter
// ebenfalls abgewiesen).
test("remoteActive: KWOS_REMOTE gewinnt, das Approval-Token ist der Rueckfall", async () => {
  const { remoteActive } = await import("../server/index.js");
  for (const v of ["1", "true", "yes", "YES", " 1 "]) {
    assert.equal(remoteActive({ KWOS_REMOTE: v }), true, JSON.stringify(v));
  }
  // Ein Launcher, der aelter ist als KWOS_REMOTE, setzt nur das Token -- eine ECHTE Remote-Sitzung
  // darf ihr Werkzeug nicht durch dieses Update verlieren.
  assert.equal(remoteActive({ KWOS_APPROVAL_TOKEN: "tok" }), true);
  for (const env of [{}, { KWOS_REMOTE: "" }, { KWOS_REMOTE: "0" }, { KWOS_REMOTE: "no" },
    { KWOS_APPROVAL_TOKEN: "" }, { KWOS_APPROVAL_TOKEN: "   " }]) {
    assert.equal(remoteActive(env), false, JSON.stringify(env));
  }
});

test("visibleTools: ask_remote steht NUR in einer Remote-Sitzung in der Liste", async () => {
  const { visibleTools } = await import("../server/index.js");
  const names = (env) => visibleTools(env).map((t) => t.name);
  assert.ok(!names({ KWOS_COLLAB_CANARY: "1" }).includes("ask_remote"),
    "Kanal frei, aber nicht remote: ask_remote darf nicht angeboten werden");
  assert.ok(names({ KWOS_COLLAB_CANARY: "1", KWOS_REMOTE: "1" }).includes("ask_remote"));
  assert.ok(names({ KWOS_APPROVAL_TOKEN: "tok" }).includes("ask_remote"));
  // Die Sperre trifft genau eines: die uebrigen Werkzeuge bleiben, wo sie waren, und das
  // Kanal-Gate besteht daneben unveraendert.
  assert.ok(names({}).includes("list_sessions"));
  assert.ok(!names({}).includes("collab_status"), "Kanal ohne Ring bleibt verborgen");
  assert.ok(names({ KWOS_COLLAB_CANARY: "1" }).includes("collab_status"));
});

test("handleToolCall: ask_remote wird auch dann abgewiesen, wenn jemand es nennt", async () => {
  const { handleToolCall } = await import("../server/index.js");
  // Der Prozess darf auf dem Testrechner keine Remote-Variable tragen (dieselbe Falle wie beim
  // Default-Pfad von collabReleased oben).
  const saved = { ...process.env };
  try {
    delete process.env.KWOS_REMOTE;
    delete process.env.KWOS_APPROVAL_TOKEN;
    await assert.rejects(() => handleToolCall("ask_remote", { question: "x" }),
      /nur in einer Remote-Control-Sitzung/);
  } finally {
    for (const k of ["KWOS_REMOTE", "KWOS_APPROVAL_TOKEN"]) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});

test("der Monitor lebt weiter, wenn kein Kanal offen ist (Regression: Exit 0 kurz nach dem Start)", async () => {
  // Gemessen 2026-10-19 (tgoebel, forkmann): der Kanal-Empfaenger beendete sich unmittelbar nach
  // dem Start mit Exit 0 und ohne eine Zeile -- beide Timer waren `unref()`-t, ein offener
  // SSE-Strom war noch nicht da, und ein haengendes Promise haelt Node nicht am Leben. Die
  // Harness-Ankuendigung stand damit fuer einen Prozess, der schon tot war.
  // Geprueft wird die ECHTE Einstiegsdatei aus monitors/monitors.json, als Prozess: die Datei,
  // die die Sitzung bekommt -- nicht ein nachgebautes Modul.
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const child = spawn(process.execPath, ["server/monitor.js"], {
    cwd: root,
    env: {
      ...process.env,
      KWOS_COLLAB_CANARY: "1",                 // der Ring ist offen
      CLAUDE_CODE_SESSION_ID: "s-live-test",   // Session-ID ohne Marker-Datei
      KWOS_RELAY_URL: "http://127.0.0.1:9",    // kein Relay: der Poll scheitert sofort
      KWOS_COLLAB_POLL_MS: "60000",            // und pollt dann nicht im Sekundentakt
    },
    // stdin als OFFENE Pipe: genau so startet der Harness den Monitor, und genau das ist der
    // Anker, an dem der Prozess haengt (s. collab-listen.js). Mit "ignore" waere stdin sofort am
    // Ende -- der Test wuerde dann die Attrappe pruefen statt die Sitzung.
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (b) => { out += String(b); });
  child.stderr.on("data", (b) => { out += String(b); });
  try {
    // Ohne die Reparatur endet der Prozess in Millisekunden; 1,5 s sind reichlich Luft.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(child.exitCode, null,
      `der Monitor ist beendet (Exit ${child.exitCode}): ${out.slice(-400)}`);
  } finally {
    child.kill("SIGTERM");
  }
});

test("collabReleased: der Monitor startet gar nicht erst, wenn der Ring ihn nicht kennt", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../server/collab-listen.js", import.meta.url), "utf8");
  const main = src.slice(src.indexOf("export async function startCollabListener"), src.indexOf("// Standalone entry"));
  const gate = main.indexOf("if (!collabReleased(env))");
  const session = main.indexOf("await ensureSessionId()");
  assert.ok(gate > 0, "das Ring-Gate muss in startCollabListener stehen");
  assert.ok(session > gate, "und VOR allem anderen: kein ensureSessionId, kein Poll, kein Strom");
  // Ausserhalb des Rings gibt es nichts zu stoppen und nichts, was angekuendigt werden koennte.
  assert.match(main.slice(gate, session), /return null/);
});

// ── Werkzeugliste hinter demselben Gate (WI 11506447) ───────────────────────────────────────
//
// Die Werkzeugliste ist das Bild, das die Sitzung von diesem Plugin hat. Die `collab_*`-Werkzeuge
// standen darin ueberall, wo das Plugin aktiv war -- also in jeder `--kwremote`-Sitzung der Flotte,
// fuer einen Kanal, den die Oberflaechen dort verbergen. Ein Name in der Liste ist ein Versprechen;
// dieses wurde nicht gehalten.
test("visibleTools: ohne Freigabe kein einziges collab_*-Werkzeug, mit Freigabe alle", async () => {
  const { TOOLS, visibleTools } = await import("../server/index.js");
  const names = (tools) => tools.map((t) => t.name);
  const collabNames = names(TOOLS).filter((n) => n.startsWith("collab_"));
  assert.ok(collabNames.length > 0, "Vorbedingung: TOOLS enthaelt die Kanal-Werkzeuge");

  for (const env of [{}, { KWOS_COLLAB_CANARY: "0" }, { KWOS_COLLAB_CANARY: "1", KWOS_NO_COLLAB: "1" }]) {
    const shown = names(visibleTools(env));
    assert.deepEqual(
      shown.filter((n) => n.startsWith("collab_")), [],
      `ohne Freigabe darf kein Kanal-Werkzeug erscheinen: ${JSON.stringify(env)}`
    );
    // Die Relay-Werkzeuge bleiben unberuehrt -- das ist der Sinn dieses Plugins in der Flotte.
    assert.ok(shown.includes("list_sessions"), "Relay-Werkzeuge duerfen nicht mitverschwinden");
  }

  for (const env of [{ KWOS_COLLAB_CANARY: "1" }, { KWOS_COLLAB_CANARY: "yes" }]) {
    // ALLE Kanal-Werkzeuge -- und nicht mehr "die ganze Liste": seit 2026-10-19 haengt
    // `ask_remote` an einem ZWEITEN Gate (Remote Control, s. die Pruefung darunter), und diese
    // Zusicherung hier gilt dem Kanal-Gate.
    assert.deepEqual(
      names(visibleTools(env)).filter((n) => n.startsWith("collab_")).sort(),
      collabNames.slice().sort(),
      JSON.stringify(env)
    );
  }
});

test("handleToolCall: ein collab_*-Aufruf ohne Freigabe erreicht den Relay nicht", async () => {
  const { handleToolCall } = await import("../server/index.js");
  const before = process.env.KWOS_COLLAB_CANARY;
  delete process.env.KWOS_COLLAB_CANARY;
  const mock = installFetchMock(() => {
    throw new Error("Der Relay darf hier gar nicht gefragt werden.");
  });
  try {
    await assert.rejects(
      () => handleToolCall("collab_status", {}),
      /nicht freigegeben \(KWOS_COLLAB_CANARY\)/
    );
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
    if (before === undefined) delete process.env.KWOS_COLLAB_CANARY;
    else process.env.KWOS_COLLAB_CANARY = before;
  }
});
