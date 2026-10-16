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
  const start = src.indexOf("if (!changed) return;");
  assert.ok(start > 0, "der Nachlauf-Zweig ist nicht mehr auffindbar -- dann prueft dieser Fall nichts");
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
