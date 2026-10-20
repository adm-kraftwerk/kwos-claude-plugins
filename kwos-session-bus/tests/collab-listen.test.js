import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { connect, createServer } from "node:net";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFetchMock } from "./helpers/fetch-mock.js";
import { MARKER_DIR, clientMarkerName } from "../server/sessionMarker.js";

// Der Kanal-Empfang im Monitor -- und der eine Fall, der ihn am 2026-10-19 in der ganzen Flotte
// stillgelegt hat: Claude Code startet einen Monitor mit `stdin = /dev/null`, und `collab-listen`
// band sein Lebensende an genau dieses stdin (`end` -> `stop()`). Bei /dev/null kommt der EOF
// SOFORT, also raeumte sich der Empfang Millisekunden nach dem Oeffnen seines Stroms selbst weg --
// die Nachricht stand in jeder Uebersicht und erreichte keine Sitzung.
//
// Der Test kann sein EIGENES stdin nicht zum Nullgeraet machen; `stdin`/`isChannel` sind dafuer die
// Naht. Ein Doppel, das beim `resume()` `end` schickt, ist genau das, was /dev/null tut.

// KWOS_XID_ACCESS_TOKEN und KWOS_CLIENT_ID MUESSEN vor dem Laden von config.js stehen (s.
// collab.test.js); der Schalter gibt den Empfangspfad frei.
process.env.KWOS_XID_ACCESS_TOKEN = "test-token";
process.env.KWOS_CLIENT_ID = "collab-listen-test";
process.env.KWOS_COLLAB_CANARY = "1";
// The read cursor is per machine and survives a process on purpose (s. collabCursor.js). A test
// must not read the developer's real notes -- and the previous test must not leave a cursor that
// swallows the next one's frame.
process.env.KWOS_COLLAB_CURSORS = join(tmpdir(), `kwcollab-cursors-${process.pid}.json`);
// The poll interval of the round tests below, not the fleet's 15 s: a round that throws is only
// visible in the NEXT round, and waiting 15 s for it would make the suite a clock test. 250 is the
// floor readCheckInterval accepts (anything below it falls back to the default); read at module load
// (collab-listen.js), hence before the import.
process.env.KWOS_COLLAB_POLL_MS = "250";
// ... and a fresh file per test: the reader's second belt drops a seq it already printed, and the
// previous test's frame would otherwise swallow the next one's.
test.beforeEach(() => {
  rmSync(process.env.KWOS_COLLAB_CURSORS, { force: true });
});

const SESSION = "11111111-2222-3333-4444-555555555555";
const COLLAB = "7f3a1b2c-9d4e-4f5a-8b6c-7d8e9f0a1b2c";

// Die EIGENE Marker-Datei beantwortet `ensureSessionId()` ohne dessen 2-s-Takt: config.js sucht sie
// von `cwd` aufwaerts (s. config.js::ownMarker).
const dir = mkdtempSync(join(tmpdir(), "kwcollab-listen-"));
mkdirSync(join(dir, MARKER_DIR), { recursive: true });
writeFileSync(join(dir, MARKER_DIR, clientMarkerName(process.env.KWOS_CLIENT_ID)), SESSION);
process.chdir(dir);

const { startCollabListener, stdinIsChannel } = await import("../server/collab-listen.js");

const jsonResponse = (body) =>
  Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify(body),
    json: async () => body,
  });

// Die Zeile kommt NACH dem Verbinden, wie beim echten Relay, dessen Strom offen bleibt. Und der
// Abbruch muss diesen Strom wirklich beenden: ein Mock, der das Signal ignoriert, liefert die Zeile
// auch einem laengst abgeraeumten Empfang noch aus -- dann faellt dieser Test nicht mehr, wenn
// jemand den Abbruch entfernt.
const sseResponse = (frame, signal) =>
  Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: () => "text/event-stream" },
    body: new ReadableStream({
      start(c) {
        let done = false;
        const t = setTimeout(() => {
          if (done) return;
          done = true;
          c.enqueue(new TextEncoder().encode(frame));
          c.close();
        }, 50);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          if (done) return;
          done = true;
          try { c.error(new Error("aborted")); } catch { /* Strom ist schon zu */ }
        });
      },
    }),
  });

// Der Kanal dieser Session, wie `GET /v1/collabs` ihn liefert -- die Mitgliedszeile nennt die
// SESSION, nicht den Login.
const collabRow = (id = COLLAB) => ({
  collab_id: id,
  workitem: "11504306",
  title: "Neu angelegt",
  my_status: "joined",
  my_role: "member",
  members: [{ subject: "u-mara", display_name: "Mara K.", session_id: SESSION, status: "joined" }],
});

// Eine Nachricht von einem MENSCHEN (nicht unsere eigene) -- genau die Zeile, die in der Sitzung
// ankommen soll.
const FRAME =
  `id: 7\nevent: message\ndata: ${JSON.stringify({
    seq: 7, collab_id: COLLAB, from_subject: "u-mara", author_kind: "human", text: "ping pong",
  })}\n\n`;
const EXPECTED_LINE = "[kwcollab 7f3a1b2c | Mara K. | human] ping pong";

/** Ein stdin-Doppel: `resume()` kann sofort EOF melden, wie es /dev/null tut. */
function stdinDouble({ eofOnResume = false } = {}) {
  const s = new EventEmitter();
  s.resumed = false;
  s.resume = () => { s.resumed = true; if (eofOnResume) setImmediate(() => s.emit("end")); };
  return s;
}

async function until(cond, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
}

test("stdinIsChannel: ein Socket ist ein Kanal, eine Datei und ein totes fd sind keiner", async () => {
  const file = openSync(join(dir, "kein-kanal"), "w");
  try {
    assert.equal(stdinIsChannel(file), false, "eine regulaere Datei ist kein Kanal");
  } finally { closeSync(file); }
  assert.equal(stdinIsChannel(999999), false, "ein unbrauchbares fd ist kein Kanal");

  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const client = connect(server.address().port, "127.0.0.1");
  await new Promise((r) => client.once("connect", r));
  try {
    const fd = client._handle?.fd;
    // Kein stilles Ueberspringen: aendert Node den Zugriff auf das fd, soll dieser Test FALLEN.
    assert.equal(typeof fd, "number", "Socket-fd nicht lesbar -- Testannahme pruefen");
    // WINDOWS KANN DIESEN FALL NICHT BAUEN (gemessen 2026-10-19): dort ist der "fd" eines
    // TCP-Sockets **-1** -- ein Handle, kein CRT-Deskriptor --, und `fstat` wirft darauf
    // ERR_OUT_OF_RANGE, also antwortet die Regel `false`. Auf POSIX ist es ein echter Deskriptor
    // und die Antwort `true`. Der Unterschied gehoert der PLATTFORM, nicht der Regel: die Regel
    // selbst deckt der Fall darunter ab (`isChannel`-Naht des Doppels), und in Produktion fragt
    // sie nach `stdin` -- dort ist die Antwort auf beiden Seiten dieselbe (NUL/`/dev/null` ist ein
    // Character-Device, also kein Kanal).
    if (process.platform === "win32") {
      assert.equal(stdinIsChannel(fd), false, "Windows: ein Socket hat dort keinen lesbaren fd");
    } else {
      assert.equal(stdinIsChannel(fd), true, "ein Socket IST ein Kanal");
    }
  } finally { client.destroy(); server.close(); }
});

test("stdin ohne Kanal (/dev/null): der Empfang lebt weiter und die Zeile kommt an", async () => {
  const mock = installFetchMock((url, init) =>
    url.includes("/events") ? sseResponse(FRAME, init?.signal) : jsonResponse({ collabs: [collabRow()] }));
  const lines = [];
  const stdin = stdinDouble({ eofOnResume: true });
  const handle = await startCollabListener({
    writeLine: (l) => lines.push(l),
    stdin,
    isChannel: () => false,
  });
  try {
    assert.ok(handle, "der Empfang muss starten (Ring ist freigegeben)");
    // Die Naht muss WIRKLICH die des Tests sein -- sonst haengt dieser Fall am stdin der Suite und
    // faellt nur dort, wo das zufaellig am EOF steht (ein Test, der von der Umgebung abhaengt).
    assert.equal(stdin.resumed, true, "der Empfang muss DIESES stdin genommen haben");
    assert.ok(await until(() => lines.length > 0), `keine Zeile angekommen (${lines.length})`);
    assert.deepEqual(lines, [EXPECTED_LINE]);
  } finally {
    handle.stop();
    await handle.ended;
    mock.restore();
  }
});

// Eine Zeile, die DIESE Sitzung als WORTE DES MENSCHEN weitergereicht hat. Sie kommt mit der
// eigenen session_id zurueck und ist als `human` gestempelt -- genau wie eine Zeile, die der Mensch
// in der Kanal-Ansicht dieser Pane tippt. Unterschieden wird ueber die Nummer (`ownHumanLines.js`).
//
// Das JSON und nicht der ganze SSE-Rahmen: `frameToLine` bekommt den `data`-Teil (es parst ihn).
const ownRelayed = (seq) =>
  JSON.stringify({
    seq, collab_id: COLLAB, from_subject: "u-mara", from_session: SESSION, author_kind: "human", text: "Frage von Steffen an Tim",
  });

test("frameToLine: die selbst weitergereichte Zeile wird verschluckt, die des Menschen nicht", async () => {
  const { frameToLine } = await import("../server/collab-listen.js");
  const { rememberOwnHumanLine, forgetOwnHumanLines } = await import("../server/ownHumanLines.js");
  const seen = { selfSessionId: SESSION, collabId: COLLAB, after: 0 };
  forgetOwnHumanLines();

  // Der Mensch tippt in der Kanal-Ansicht DIESER Pane: `from_session` ist unsere eigene -- und die
  // Zeile MUSS ankommen, sonst faellt genau der Fall weg, fuer den die Ausnahme gebaut wurde.
  assert.ok(frameToLine(ownRelayed(8), seen), "die Zeile des Menschen in dieser Pane wurde verschluckt");

  // Unsere eigene, weitergegebene Zeile dagegen nicht: der Sendeweg hat ihre Nummer gemerkt.
  rememberOwnHumanLine(7);
  assert.equal(
    frameToLine(ownRelayed(7), seen),
    null,
    "die eigene Zeile wurde zurueckgespielt und die Sitzung antwortet sich selbst",
  );
  // ... und die Nummer ist damit VERBRAUCHT: die Sperre gilt fuer die eine Zustellung, nicht fuer
  // jede Nummer, die spaeter zufaellig dieselbe ist.
  assert.ok(frameToLine(ownRelayed(7), seen), "die Nummer wurde fuer immer gesperrt");
});

test("stdin MIT Kanal: sein EOF beendet den Empfang weiterhin", async () => {
  const mock = installFetchMock((url, init) =>
    url.includes("/events") ? sseResponse(FRAME, init?.signal) : jsonResponse({ collabs: [collabRow()] }));
  const lines = [];
  const stdin = stdinDouble();
  const handle = await startCollabListener({
    writeLine: (l) => lines.push(l),
    stdin,
    isChannel: () => true,
  });
  try {
    assert.ok(await until(() => lines.length > 0), "der Empfang muss erst laufen");
    // Der Anker bleibt fuer den Fall, fuer den er gedacht war: eine Sitzung, die ihren Kanal
    // wirklich haelt, beendet den Empfang mit ihm.
    stdin.emit("end");
    await handle.ended;
  } finally {
    mock.restore();
  }
});

/**
 * The lines this plugin writes to stderr (server/log.js) while `run` does its work, plus the way
 * back. A round that throws must be NAMED, and the name is the whole point of the change -- so the
 * test reads the log instead of trusting that a failure "would have been visible".
 */
function captureStderr() {
  const real = process.stderr.write;
  const seen = [];
  process.stderr.write = (chunk, ...rest) => {
    seen.push(String(chunk));
    return real.call(process.stderr, chunk, ...rest);
  };
  return { seen, restore: () => { process.stderr.write = real; } };
}

// Serving this worktree's snapshots is a SIDE JOB of the round. As a bare await, a throw there ended
// the whole round: the channels behind it never got a stream, and in the first round the receive path
// never came up at all -- the session sat in a channel that delivered nothing, with no line anywhere
// (WI 11523603).
test("a throwing code serving costs its channel, not the round", async () => {
  const bad = "11111111-1111-4111-8111-111111111111";
  const mock = installFetchMock((url, init) =>
    url.includes("/events")
      ? sseResponse(FRAME, init?.signal)
      : jsonResponse({ collabs: [collabRow(bad), collabRow(COLLAB)] }));
  const lines = [];
  const refreshed = [];
  const log = captureStderr();
  const handle = await startCollabListener({
    writeLine: (l) => lines.push(l),
    stdin: stdinDouble(),
    isChannel: () => false,
    codeServing: () => ({
      refresh: async (id) => { refreshed.push(id); if (id === bad) throw new Error("bereitstellen kaputt"); },
      drop: () => {},
    }),
  });
  try {
    assert.ok(await until(() => lines.length > 0), `der zweite Kanal bekam keinen Strom (${refreshed.join(", ")})`);
    assert.deepEqual(refreshed.slice(0, 2), [bad, COLLAB], "beide Kanaele wurden in dieser Runde angefasst");
    assert.ok(lines.every((l) => l === EXPECTED_LINE));
    assert.ok(
      log.seen.some((l) => /Code-Austausch nicht aktualisiert/.test(l)),
      `der Fehler blieb stumm: ${log.seen.join("")}`,
    );
  } finally {
    handle.stop();
    await handle.ended;
    log.restore();
    mock.restore();
  }
});

// A round that throws where the round's own catches end used to be swallowed by the interval
// (`poll().catch(() => {})`), and a rejected FIRST round ended the receive path outright: `running`
// rejected, its teardown cleared the watch timer and every stream, and the interval that would have
// retried was never even installed (WI 11523603). One bad round must cost one round.
test("a rejected poll round is named and does not take the receive path down", async () => {
  const frame = (seq) =>
    `id: ${seq}\nevent: message\ndata: ${JSON.stringify({
      seq, collab_id: COLLAB, from_subject: "u-mara", author_kind: "human", text: "ping pong",
    })}\n\n`;
  let listed = [collabRow()];
  let seq = 7;
  const mock = installFetchMock((url, init) =>
    url.includes("/events") ? sseResponse(frame(seq), init?.signal) : jsonResponse({ collabs: listed }));
  const lines = [];
  let drops = 0;
  const log = captureStderr();
  const handle = await startCollabListener({
    writeLine: (l) => lines.push(l),
    stdin: stdinDouble(),
    isChannel: () => false,
    // The step of the round that throws outside those catches: the channel disappears from the
    // relay's list, and the monitor's own `drop` fails on the way out. It fails ONCE -- the round it
    // belongs to. A `drop` that threw again would be this test's own double at work in the teardown
    // (`closeAll` calls it unwrapped as well), and the test would measure itself.
    codeServing: () => ({ refresh: async () => {}, drop: () => { if (++drops === 1) throw new Error("Runde kaputt"); } }),
  });
  const polls = () => mock.calls.filter((c) => !c.url.includes("/events")).length;
  try {
    assert.ok(await until(() => lines.length === 1), "die erste Runde muss den Kanal oeffnen");

    listed = [];   // the channel is gone -- the next round drops it, and that step throws
    assert.ok(await until(() => drops === 1), "die Runde mit dem Wurf muss ueberhaupt laufen");
    const before = polls();
    assert.ok(
      log.seen.some((l) => /Kollab-Runde abgebrochen/.test(l)),
      `die geworfene Runde blieb stumm: ${log.seen.join("")}`,
    );

    // The receive path is still up: the interval keeps polling ...
    assert.ok(await until(() => polls() > before + 1), "der Takt laeuft nach der geworfenen Runde nicht mehr");
    // ... and the channel that comes back delivers lines again.
    seq = 8;
    listed = [collabRow()];
    assert.ok(await until(() => lines.length === 2), `kein Empfang nach der geworfenen Runde (${lines.length} Zeilen)`);
    assert.equal(lines[1], EXPECTED_LINE);
  } finally {
    handle.stop();
    await handle.ended;
    log.restore();
    mock.restore();
  }
});
