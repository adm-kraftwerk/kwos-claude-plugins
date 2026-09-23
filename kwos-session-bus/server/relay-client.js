import { config } from "./config.js";
import { getAccessToken } from "./auth.js";

/**
 * @typedef {Object} SessionInfo
 * @property {string} session_id
 * @property {string} display_name
 * @property {string} [team]
 * @property {string} last_heartbeat
 */

/**
 * @typedef {Object} RelayMessage
 * @property {number} seq
 * @property {string} message_id
 * @property {string} from_session
 * @property {string} to_session
 * @property {string} text
 * @property {string} created_at
 * @property {string|null} delivered_at
 * @property {string|null} attachment_id
 * @property {string} [workitem_ref]
 */

async function call(path, { method = "GET", body, headers } = {}) {
  if (!config.relayUrl) {
    throw new Error("KWOS_RELAY_URL ist nicht gesetzt.");
  }
  const token = await getAccessToken();
  const res = await fetch(`${config.relayUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok && res.status !== 202) {
    const text = await res.text().catch(() => "");
    throw new Error(`Relay ${method} ${path} -> ${res.status}: ${text}`);
  }

  const queued = res.status === 202;
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, queued, data };
}

/** POST /v1/sessions/register — bei Session-Start, nicht als Tool exponiert. */
export function register() {
  return call("/v1/sessions/register", {
    method: "POST",
    body: { session_id: config.sessionId, display_name: config.displayName, channels: config.channels },
  });
}

/** POST /v1/sessions/{self}/heartbeat — periodisch, nicht als Tool exponiert. */
export function heartbeat() {
  return call(`/v1/sessions/${encodeURIComponent(config.sessionId)}/heartbeat`, {
    method: "POST",
  });
}

/** GET /v1/sessions — Tool list_sessions. */
export async function listSessions() {
  const { data } = await call("/v1/sessions");
  return /** @type {SessionInfo[]} */ (data ?? []);
}

/**
 * POST /v1/sessions/{target}/messages — Tool send_message.
 * 201 = Zielsession online, 202 = queued (Zielsession offline/unbekannt).
 */
export async function sendMessage(target, text, workitemRef) {
  const { status, queued } = await call(`/v1/sessions/${encodeURIComponent(target)}/messages`, {
    method: "POST",
    body: { from: config.sessionId, text, workitem_ref: workitemRef },
  });
  return { delivered: status === 201, queued };
}

/** POST /v1/sessions/broadcast — Tool broadcast. */
export async function broadcast(text, workitemRef) {
  await call("/v1/sessions/broadcast", {
    method: "POST",
    body: { from: config.sessionId, text, workitem_ref: workitemRef },
  });
}

/** URL für den SSE-Empfang, GET /v1/sessions/{self}/events. */
export function eventsUrl() {
  return `${config.relayUrl}/v1/sessions/${encodeURIComponent(config.sessionId)}/events`;
}

/**
 * POST /v1/channels/{channel}/publish — Tool notify_dependents (WI 10383787).
 * Erreicht JEDE Session (auch fremder Subjects/Teams), die diesen Channel abonniert hat --
 * bewusst ohne canSend-Team-Schranke (Channel = explizites gegenseitiges Opt-in, s. relay/server.js).
 */
export async function publishToChannel(channel, text, workitemRef) {
  const { data } = await call(`/v1/channels/${encodeURIComponent(channel)}/publish`, {
    method: "POST",
    body: { from: config.sessionId, text, workitem_ref: workitemRef },
  });
  return data ?? { channel, fanout: 0, results: [] };
}

/**
 * POST /v1/questions — Tool ask_remote (WI 10383786). Blockiert server-seitig bis zu ~9,5 Min
 * (relay/server.js QUESTION_WAIT_MS), bis eine Antwort ueber die PWA kommt oder das Zeitfenster
 * ablaeuft. Liefert { status: "answered", answer } oder { status: "timeout" } -- niemals einen
 * Fehler nur wegen Zeitablauf, damit der Agent selbst entscheiden kann, wie es weitergeht.
 */
export async function askRemote(question, options) {
  const { data } = await call("/v1/questions", {
    method: "POST",
    body: { session_id: config.sessionId, question, options },
  });
  return data ?? { status: "timeout" };
}

/**
 * GET /v1/sessions/{self}/messages?since= — Tool get_message (WI 11075502). Der Monitor kappt
 * lange Nachrichten selbst (s. listen.js, MAX_LINE_CHARS) und nennt in der Notification nur noch
 * Laenge und seq; den vollstaendigen Text holt die Session hier auf Abruf -- dasselbe Muster wie
 * get_attachment, kein Autowake.
 *
 * `since=seq-1`, damit die gesuchte Nachricht die ERSTE der Antwort ist: der Relay liefert
 * aufsteigend nach seq und begrenzt auf 500 Zeilen (relay/server.js) -- ein Treffer kann so nicht
 * hinter die erste Seite fallen. Der Endpunkt liefert nur die an DIESE Session zugestellten
 * Nachrichten, also genau die, die der Monitor angekuendigt hat.
 *
 * TEILUNG (Review-Fund zu WI 11075502): der Relay teilt lange Nachrichten VOR dem Speichern in
 * Chunks "(i/n) " mit je EIGENER seq (relay/lib.js splitLongMessage, MESSAGE_SPLIT_MAX_LEN=900).
 * Ein 5000-Zeichen-Bericht sind dort also sechs Zeilen -- eine, die nur ihre eigene Zeile
 * zurueckgibt, liefert 18 % des Berichts, waehrend der Aufrufer "vollstaendigen Text" erwartet.
 * Deshalb werden die zusammengehoerigen Chunks hier wieder zusammengesetzt. Das Nummerierungs-
 * format ist kein Zufall: relay/lib.js begruendet es ausdruecklich damit, dass "sowohl der Mensch
 * im PWA-Verlauf als auch das LLM erkennen, dass mehrere Zeilen zusammengehoeren".
 *
 * Rueckgabe: das RelayMessage-Objekt mit `text` = zusammengesetzter Text, plus `chunks`
 * (Anzahl der Teile), `incomplete` (true, wenn ein Teil fehlt) und `missingSeqs`.
 */
async function fetchMessagesSince(since) {
  const { data } = await call(`/v1/sessions/${encodeURIComponent(config.sessionId)}/messages?since=${since}`);
  if (data === null || !Array.isArray(data?.messages)) {
    // call() schluckt einen JSON-Parse-Fehler zu null (res.json().catch(() => null)). Das ist
    // NICHT dasselbe wie "keine Nachricht gefunden" -- eine HTML-Fehlerseite eines Gateways darf
    // nicht als "aus dem Verlauf rotiert" gedeutet werden, das schickt den Leser in die falsche
    // Richtung.
    throw new Error(
      `get_message: die Antwort des Relays war kein lesbares JSON -- vermutlich eine ` +
        `Fehlerseite/Proxy-Antwort, nicht ein leerer Verlauf.`
    );
  }
  return data.messages;
}

export async function getMessage(seq) {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new Error(`get_message: seq muss eine positive Ganzzahl sein (erhalten: ${JSON.stringify(seq)}).`);
  }
  const messages = await fetchMessagesSince(seq - 1);
  const target = /** @type {RelayMessage|undefined} */ (messages.find((m) => m.seq === seq));
  if (!target) {
    throw new Error(
      `get_message: keine Nachricht mit seq=${seq} im eigenen Verlauf gefunden -- entweder aus dem ` +
        `Verlauf rotiert oder eine seq, die nicht an diese Session ging.`
    );
  }

  // Aufruf mit der seq eines MITTLEREN Teils: jede gekappte Zeile traegt ihre eigene seq im
  // Marker, also ruft die Session regelmaessig mit "Teil 3 von 7" auf. Die erste Seite
  // (since=seq-1) kennt nur die Teile ab hier -- der Kopf liegt DAVOR. Deshalb eine zweite Seite
  // von der Kopf-Seq an holen und ab Teil 1 zusammensetzen. Ohne das kaeme still 70 % zurueck,
  // als "vollstaendig" ausgegeben.
  const marker = parseChunkMarker(target.text);
  if (marker && marker.index > 1) {
    const startSeq = seq - (marker.index - 1);
    if (startSeq >= 1) {
      const earlier = await fetchMessagesSince(startSeq - 1);
      const head = earlier.find((m) => m.seq === startSeq);
      // Kopf gefunden -> von dort zusammensetzen. Nicht gefunden -> mit dem vorhandenen Rest
      // weitermachen; assembleSplitRun meldet die fehlenden Kopfteile dann als Luecke.
      if (head) return assembleSplitRun(head, earlier);
    }
  }
  return assembleSplitRun(target, messages);
}

/** "(i/n) rest" -> { index, total, body }; null, wenn keine Chunk-Nummerierung vorliegt. */
function parseChunkMarker(text) {
  const m = typeof text === "string" ? /^\((\d+)\/(\d+)\) ?/.exec(text) : null;
  if (!m) return null;
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (!Number.isInteger(index) || !Number.isInteger(total) || total < 2 || index < 1 || index > total) return null;
  return { index, total, body: text.slice(m[0].length) };
}

/**
 * Setzt eine per "(i/n)" geteilte Nachricht wieder zusammen. Die Chunks liegen als aufeinander-
 * folgende seqs vor (relayMessage() fuegt sie in einer Schleife ein); ausgehend von der seq des
 * uebergebenen Teils wird der Bereich 1..n abgeklappert. Fehlende Teile werden GESAMMELT und
 * gemeldet -- nicht nur die erste Luecke, und nicht still gekuerzt.
 *
 * Die Nahtstellen werden mit einem Leerzeichen gefuellt: splitLongMessage() bricht auf
 * Wortgrenzen und entfernt dabei genau dieses Trennzeichen (relay/lib.js). Beim HARTEN Schnitt
 * ("kein Wortgrenzen-Treffer" -> cut = maxLen) war jedoch gar kein Trenner da -- dann entsteht an
 * der Naht ein Leerzeichen zuviel. Das ist eine bekannte, dokumentierte Naeherung; deshalb heisst
 * es "zusammengesetzt" und nicht "byte-identisch".
 */
function assembleSplitRun(target, messages) {
  const first = parseChunkMarker(target.text);
  if (!first) return { ...target, chunks: 1, incomplete: false, missingSeqs: [], missingHead: false };

  const bySeq = new Map(messages.map((m) => [m.seq, m]));
  const startSeq = target.seq - (first.index - 1);
  const bodies = [];
  const missingSeqs = [];
  // Kopfteile vor seq 1 gibt es nicht -- sie duerfen nicht als "seq=0" gemeldet werden (eine seq,
  // die es nicht geben kann, schickt den Leser auf eine sinnlose Suche).
  let missingHead = startSeq < 1;
  for (let i = 1; i <= first.total; i++) {
    const at = startSeq + (i - 1);
    const row = i === first.index ? target : bySeq.get(at);
    const parsed = row ? (i === first.index ? first : parseChunkMarker(row.text)) : null;
    if (!parsed || parsed.index !== i || parsed.total !== first.total || row.from_session !== target.from_session) {
      if (at >= 1) missingSeqs.push(at);
      else missingHead = true;
      continue;
    }
    bodies.push(parsed.body);
  }
  return {
    ...target,
    text: bodies.join(" "),
    chunks: first.total,
    incomplete: missingSeqs.length > 0 || missingHead,
    missingSeqs,
    missingHead,
  };
}

/**
 * GET /v1/attachments/{id} — Tool get_attachment (WI 10460008, Phase 2). Liefert KEIN JSON
 * (roher Bild-Body + Content-Type), deshalb eigener Fetch statt call() (das jede Antwort per
 * res.json() parst). Autorisierung spiegelt serverseitig relay/server.js: Sender, Owner der
 * Empfaenger-Session, oder gleiches Team -- ein 403/404 hier ist also kein Bug, sondern bedeutet
 * "diese Session darf/kann das Bild nicht sehen".
 */
export async function getAttachment(id) {
  if (!config.relayUrl) {
    throw new Error("KWOS_RELAY_URL ist nicht gesetzt.");
  }
  const token = await getAccessToken();
  const res = await fetch(`${config.relayUrl}/v1/attachments/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Relay GET /v1/attachments/${id} -> ${res.status}: ${text}`);
  }
  // image/jpeg|png|webp -- s. okAttachmentMime in relay/lib.js, kein anderer Wert moeglich.
  const mimeType = res.headers.get("content-type") || "application/octet-stream";
  const buf = Buffer.from(await res.arrayBuffer());
  return { mimeType, data: buf.toString("base64") };
}
