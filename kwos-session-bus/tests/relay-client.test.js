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

// ── getMessage (WI 11075502) ──────────────────────────────────────────────────
// Der Monitor kappt lange Nachrichten selbst und nennt nur noch seq -- der volle Text kommt auf
// Abruf. Der Relay-Endpunkt dafuer existiert bereits (GET /v1/sessions/:self/messages?since=,
// relay/server.js im litellm-Repo), es fehlte nur die Plugin-Seite.

test("getMessage: holt die Nachricht per since=seq-1 und liefert den vollen Text", async () => {
  config.sessionId = "sess-self";
  const full = "x".repeat(5000);
  const mock = installFetchMock(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        messages: [{ seq: 42, message_id: "m1", from_session: "sess-abc", to_session: "sess-self", text: full, attachment_id: null }],
      }),
    })
  );
  try {
    const msg = await relay.getMessage(42);
    assert.equal(msg.text, full);
    assert.equal(mock.calls.length, 1);
    assert.match(mock.calls[0].url, /\/v1\/sessions\/sess-self\/messages\?since=41$/);
    assert.equal(mock.calls[0].init.headers.Authorization, "Bearer test-token");
  } finally {
    mock.restore();
  }
});

test("getMessage: keine passende seq in der Antwort -> wirft statt still undefined", async () => {
  config.sessionId = "sess-self";
  const mock = installFetchMock(() =>
    Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ messages: [] }) })
  );
  try {
    await assert.rejects(() => relay.getMessage(99), /seq=99/);
  } finally {
    mock.restore();
  }
});

test("getMessage: ungueltige seq wirft VOR jedem Netzwerkaufruf", async () => {
  config.sessionId = "sess-self";
  const mock = installFetchMock(() => {
    throw new Error("fetch haette hier NICHT aufgerufen werden duerfen");
  });
  try {
    await assert.rejects(() => relay.getMessage("42abc"), /seq/);
    await assert.rejects(() => relay.getMessage(undefined), /seq/);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

// ── Geteilte Nachrichten (Review-Fund F1 zu WI 11075502) ──────────────────────
// Der Relay teilt lange Nachrichten VOR dem Speichern in Chunks "(i/n) " mit je eigener seq
// (relay/lib.js splitLongMessage, MESSAGE_SPLIT_MAX_LEN=900). Ein 5000-Zeichen-Bericht ist dort
// also SECHS Zeilen. Ein get_message, das nur die eine Zeile zurueckgibt, liefert dann 18 % des
// Berichts -- waehrend die Tool-Beschreibung "vollstaendiger Text" verspricht.

const page = (rows) => Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ messages: rows }) });
const row = (seq, text, from = "sess-abc") => ({ seq, from_session: from, to_session: "sess-self", text, attachment_id: null });

test("getMessage: setzt eine per '(i/n)' geteilte Nachricht wieder zusammen", async () => {
  config.sessionId = "sess-self";
  const mock = installFetchMock(() =>
    page([row(10, "(1/3) Der Bericht ist lang"), row(11, "(2/3) und geht weiter"), row(12, "(3/3) und endet hier")])
  );
  try {
    const msg = await relay.getMessage(10);
    assert.equal(msg.text, "Der Bericht ist lang und geht weiter und endet hier");
    assert.equal(msg.chunks, 3);
    assert.equal(msg.incomplete, false);
  } finally {
    mock.restore();
  }
});

test("getMessage: unabhaengige Nachrichten danach werden NICHT mit eingesammelt", async () => {
  config.sessionId = "sess-self";
  const mock = installFetchMock(() =>
    page([row(10, "(1/2) erster Teil"), row(11, "(2/2) zweiter Teil"), row(12, "eine ganz andere Nachricht")])
  );
  try {
    const msg = await relay.getMessage(10);
    assert.equal(msg.text, "erster Teil zweiter Teil");
    assert.ok(!msg.text.includes("andere Nachricht"), msg.text);
  } finally {
    mock.restore();
  }
});

test("getMessage: fehlender Teil wird als unvollstaendig gemeldet, nicht stillschweigend gekuerzt", async () => {
  config.sessionId = "sess-self";
  const mock = installFetchMock(() => page([row(10, "(1/3) erster Teil"), row(11, "(2/3) zweiter Teil")]));
  try {
    const msg = await relay.getMessage(10);
    assert.equal(msg.text, "erster Teil zweiter Teil");
    assert.equal(msg.incomplete, true);
    assert.equal(msg.chunks, 3);
    assert.deepEqual(msg.missingSeqs, [12]);
  } finally {
    mock.restore();
  }
});

test("getMessage: Nachricht ohne '(i/n)' bleibt unveraendert (kein falsches Zusammensetzen)", async () => {
  config.sessionId = "sess-self";
  const mock = installFetchMock(() => page([row(10, "kurze Nachricht"), row(11, "noch eine")]));
  try {
    const msg = await relay.getMessage(10);
    assert.equal(msg.text, "kurze Nachricht");
    assert.equal(msg.chunks, 1);
    assert.equal(msg.incomplete, false);
  } finally {
    mock.restore();
  }
});

test("getMessage: kaputte Relay-Antwort wird als solche gemeldet, nicht als 'nicht gefunden'", async () => {
  config.sessionId = "sess-self";
  // 200 mit einem Body, der kein JSON ist (z.zB. eine HTML-Fehlerseite eines Gateways).
  const mock = installFetchMock(() =>
    Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new Error("not json"); } })
  );
  try {
    await assert.rejects(
      () => relay.getMessage(42),
      (err) => {
        assert.match(err.message, /keine JSON|unlesbar|Antwort/i);
        assert.ok(!/rotiert|nicht an diese Session/.test(err.message), `falsche Ursache gemeldet: ${err.message}`);
        return true;
      }
    );
  } finally {
    mock.restore();
  }
});

// ── Aufruf mit der seq eines MITTLEREN Teils (Review-Fund zu WI 11075502) ─────
// Jede gekappte Zeile traegt ihre EIGENE seq im Marker. Die Session ruft also regelmaessig mit
// der seq von Teil 3 von 7 auf -- nicht nur mit der des ersten Teils. Eine Fassung, die nur
// vorwaerts sammelt, liefert dann 70 % und meldet trotzdem "vollstaendig".

/** Antwortet je nach `since`-Parameter mit der passenden Seite. */
function pagedMock(pagesBySince) {
  return installFetchMock((url) => {
    const since = Number(/since=(\d+)/.exec(url)?.[1]);
    const rows = pagesBySince[since];
    if (!rows) throw new Error(`unerwartetes since=${since}`);
    return page(rows);
  });
}

test("getMessage: Aufruf mit der seq eines MITTLEREN Teils liefert die GANZE Nachricht", async () => {
  config.sessionId = "sess-self";
  // Teile 1..4 mit seq 100..103. Erste Seite (since=101) sieht nur 102,103 -- der Kopf liegt davor.
  const mock = pagedMock({
    101: [row(102, "(3/4) dritter"), row(103, "(4/4) vierter")],
    99: [row(100, "(1/4) erster"), row(101, "(2/4) zweiter"), row(102, "(3/4) dritter"), row(103, "(4/4) vierter")],
  });
  try {
    const msg = await relay.getMessage(102);
    assert.equal(msg.text, "erster zweiter dritter vierter");
    assert.equal(msg.chunks, 4);
    assert.equal(msg.incomplete, false);
    assert.equal(mock.calls.length, 2, "der Kopf muss mit einer zweiten Seite geholt werden");
    assert.match(mock.calls[1].url, /since=99$/);
  } finally {
    mock.restore();
  }
});

test("getMessage: fehlt der Kopf, wird das gemeldet statt still bei Teil k zu beginnen", async () => {
  config.sessionId = "sess-self";
  const mock = pagedMock({
    101: [row(102, "(3/4) dritter"), row(103, "(4/4) vierter")],
    99: [], // Kopf nicht mehr im Verlauf
  });
  try {
    const msg = await relay.getMessage(102);
    assert.equal(msg.incomplete, true);
    assert.deepEqual(msg.missingSeqs, [100, 101]);
    assert.match(msg.text, /dritter vierter/);
  } finally {
    mock.restore();
  }
});

test("getMessage: ALLE fehlenden Teile werden benannt, nicht nur die erste Luecke", async () => {
  config.sessionId = "sess-self";
  const mock = pagedMock({
    99: [row(100, "(1/5) eins"), row(102, "(3/5) drei"), row(104, "(5/5) fuenf")],
  });
  try {
    const msg = await relay.getMessage(100);
    assert.equal(msg.chunks, 5);
    assert.equal(msg.incomplete, true);
    assert.deepEqual(msg.missingSeqs, [101, 103]);
    assert.equal(msg.text, "eins drei fuenf");
  } finally {
    mock.restore();
  }
});

test("getMessage: Nahtstellen werden mit einem Leerzeichen zusammengesetzt (dokumentierte Naeherung)", async () => {
  config.sessionId = "sess-self";
  // Beim Wortgrenzen-Schnitt ist das Leerzeichen genau das entfernte Trennzeichen -> korrekt.
  const withSpace = pagedMock({ 9: [row(10, "(1/2) erster Teil"), row(11, "(2/2) zweiter Teil")] });
  try {
    assert.equal((await relay.getMessage(10)).text, "erster Teil zweiter Teil");
  } finally {
    withSpace.restore();
  }
  // Beim HARTEN Schnitt (kein Leerzeichen im Fenster, relay/lib.js: cut <= 0 -> cut = maxLen) war
  // gar kein Trenner da -- dann entsteht an der Naht ein Leerzeichen zuviel. Bekannt, dokumentiert,
  // und deshalb sagt die Tool-Beschreibung "zusammengesetzt", nicht "byte-identisch".
  const hardCut = pagedMock({ 9: [row(10, "(1/2) wwwwwwwwww"), row(11, "(2/2) wwwwwwwwww")] });
  try {
    assert.equal((await relay.getMessage(10)).text, "wwwwwwwwww wwwwwwwwww");
  } finally {
    hardCut.restore();
  }
});

test("getMessage: nennt nie die seq 0 (die es nicht gibt) fuer fehlende Kopfteile", async () => {
  config.sessionId = "sess-self";
  // Teil 2 von 3 auf seq=1: der Kopf muesste bei seq 0 liegen -- den kann es nicht geben.
  const mock = pagedMock({ 0: [row(1, "(2/3) zweiter")] });
  try {
    const msg = await relay.getMessage(1);
    assert.equal(msg.incomplete, true);
    assert.ok(!msg.missingSeqs.includes(0), `seq 0 gemeldet: ${JSON.stringify(msg.missingSeqs)}`);
    assert.equal(msg.missingHead, true);
  } finally {
    mock.restore();
  }
});
