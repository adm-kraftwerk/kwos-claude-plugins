#!/usr/bin/env node
/**
 * bots-mcp.mjs — die eigenen Bots als MCP: lesen und triggeren (WI 11609130, Abstimmung mit
 * WI 11619349 am 2026-11-14).
 *
 * WOZU: Der Relay hat die Routen laengst, und die Kommandozeile und die Oberflaeche nutzen sie. Was
 * fehlte, war der Weg fuer einen Agenten: seine Bots sehen und einen Lauf anstossen. Dieses MCP
 * wrappt GENAU die vorhandenen Routen — es erfindet keine eigene Bot-Auswahl und keine eigene
 * Berechtigungspruefung:
 *
 *   bots_list     GET /v1/bots              (eigene)   + GET /v1/me/managed-bots (Katalog)
 *   bot_trigger   POST /v1/bots/:bot/jobs   (idempotent ueber die mitgeschickte job_id)
 *   bot_jobs      GET /v1/bots/:bot/jobs    (Zustand, ohne Ausgabe)
 *   bot_job       GET /v1/bots/:bot/jobs/:job (ein Lauf MIT Ausgabe)
 *   bot_cancel    POST /v1/bots/:bot/jobs/:job/cancel (anhaelt; ein beendeter Lauf nennt seinen Zustand)
 *
 * WER FRAGT: die PERSON. Der Token geht als `Bearer` an den Relay, dessen `auth` ihn gegen
 * `/oidc/me` prueft; `req.subject` ist damit die anfragende Person, und „nur eigene Bots" ist die
 * WHERE-Klausel der Anweisung, nicht eine Pruefung hier. Ein Service-Token haette ein anderes
 * Subjekt und traefe keinen fremden Bot — dieser Helfer holt darum den PERSONEN-Token.
 *
 * WAS DAS MCP NICHT BEHAUPTET:
 *   * Die Antwort auf einen Trigger ist die JOB-ZEILE (Status `pending`), nicht das Ergebnis. Das
 *     Ergebnis liest man spaeter mit `GET /v1/bots/:bot/jobs/:job` (`output`) oder der Lauf
 *     schreibt selbst in seinen Kanal.
 *   * Ob ein Bot angenommen wird, entscheidet der Relay (abgeschaltet, offener Lauf, Katalog-Bot
 *     ausserhalb der Zielgruppe, Tagesdeckel). Seine Ablehnung wird WOERTLICH weitergegeben; das
 *     MCP verbietet nichts vorab, damit eine spaetere Oeffnung nicht hier nachgezogen werden muss.
 *
 * PROTOKOLL: MCP ueber stdio, zeilenweise JSON-RPC 2.0 (die Transportform des MCP). Auf stdout
 * steht NUR das Protokoll; alles andere geht auf stderr.
 *
 * GRENZEN, die dieses MCP bewusst zieht:
 *   * Vom Header-Helfer werden NUR `Authorization` (ein `Bearer `-Token) und `X-KWOS-Workitem`
 *     uebernommen. Seine stderr wird gelesen, aber NIE in ein Werkzeugergebnis uebernommen; dort
 *     stehen hoechstens Exit-Code und Fehlerklasse.
 *   * Die Gateway-Adresse muss `https:` sein; jede andere Adresse wird beim Aufruf mit einem
 *     klaren Grund abgelehnt.
 *   * `notifications/cancelled` bricht den laufenden Aufruf per AbortSignal ab. Danach kommt keine
 *     Antwort mehr — eine abgebrochene Anfrage ist keine Antwort wert.
 *   * Der Prozess endet nicht per `process.exit`: das schnitt die letzte Antwort ab (gemessen:
 *     65.536 von 85.969 Byte kamen ueber eine Pipe). `process.exitCode` plus schliessendes
 *     readline laesst Node die offenen Schreibvorgaenge ausliefern.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const SERVER_NAME = "kwos-bots";
const SERVER_VERSION = "1.0.0";

/** Wohin die Routen gehen. Ueberschreibbar, damit eine Sitzung gegen einen anderen Ring testen kann. */
const DEFAULT_GATEWAY = "https://llm.os.kraftwerk.io";

/** Ein Aufruf ist ein Auftrag, kein Download; laenger als das ist der Relay nicht erreichbar. */
const HTTP_TIMEOUT_MS = 30_000;

/** Der Header-Helfer darf so lange brauchen — danach gilt er als nicht erreichbar. */
const HELPER_TIMEOUT_MS = 30_000;

/** Fremdtext kommt nur gekuerzt in das Transkript, und der ganze Werkzeugtext ist gedeckelt. */
const RAW_SNIPPET_MAX = 2_000;
const TOOL_TEXT_MAX = 64 * 1024;

/**
 * Format einer Kennung, die in einen Pfad wandert. `encodeURIComponent` kodiert `.` NICHT, darum
 * entscheidet dieses Muster (und nicht die Kodierung) ueber `..`-Pfadverbiegungen.
 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const PROMPT_MAX = 65_536;

/** Die Protokollfassungen, die dieses MCP kennt. Die hoechste ist die Vorgabe. */
const PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const PROTOCOL_VERSION = PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1];

const TOOLS = [
  {
    name: "bots_list",
    description:
      "Meine Bots in einer Liste: die eigenen (GET /v1/bots) und die Katalog-Bots, die ich nutzen "
      + "darf (GET /v1/me/managed-bots). Jede Zeile nennt `origin` = \"own\" oder \"managed\" und "
      + "sonst die Felder, die der Relay liefert. Die `bot_id` aus dieser Liste ist der einzige "
      + "gueltige Eingang fuer bot_trigger — nichts raten.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "bot_trigger",
    description:
      "Einen Bot mit einem Auftrag starten (POST /v1/bots/:bot/jobs). Die Antwort ist die Job-Zeile "
      + "mit Status `pending` — NICHT das Ergebnis; das liest man spaeter ueber GET "
      + "/v1/bots/:bot/jobs/:job. `job_id` ist der Idempotenzschluessel: derselbe Wert zweimal "
      + "startet keinen zweiten Lauf (Antwort dann created=false). Ohne `job_id` vergibt das MCP "
      + "eine UUID. Ob der Bot den Auftrag annimmt, entscheidet der Relay; seine Ablehnung "
      + "(abgeschaltet, schon ein offener Lauf, Deckel erreicht, Zielgruppe) kommt woertlich zurueck.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "Die bot_id aus bots_list." },
        prompt: { type: "string", description: "Der Auftrag fuer den Bot (1..65536 Zeichen)." },
        job_id: {
          type: "string",
          description:
            "Idempotenzschluessel ([A-Za-z0-9._-], max 200). Bei einem Retry DERSELBE Wert; ohne "
            + "Angabe vergibt das MCP eine UUID.",
        },
        kind: { type: "string", description: "Nur setzen, wenn wirklich eine andere Art gemeint ist; sonst nimmt der Server seinen Vorgabewert." },
        workitem: { type: "string", description: "Workitem, auf das der Lauf bucht; ohne Angabe das des Bots." },
        automation_id: {
          type: "string",
          description:
            "Eine bestimmte Automation eines EIGENEN Bots als Ausloeser. Ein Katalog-Bot nimmt "
            + "keine Automation an — der Relay lehnt dann mit 409 ab, und die Absage kommt "
            + "woertlich zurueck; sie wird hier nicht vorab weggelassen.",
        },
      },
      required: ["bot_id", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "bot_jobs",
    description:
      "Die Laeufe EINES Bots, die mir gehoeren (GET /v1/bots/:bot/jobs) -- der Zustand ohne den "
      + "Umweg ueber die Oberflaeche. Die Liste enthaelt KEIN `output`; dafuer `bot_job`. "
      + "Filter: `status`, `job_id`, `order` (oldest|newest), `limit`. Ein unbekannter Filter oder "
      + "Status wird vom Relay abgelehnt und kommt woertlich zurueck.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "Die bot_id aus bots_list." },
        status: {
          type: "string",
          description: "Nur Laeufe in diesem Zustand: pending, leased, done, failed, cancelled.",
        },
        job_id: { type: "string", description: "Genau diesen Lauf, auch wenn er aelter als die Seite ist." },
        order: { type: "string", description: "oldest (Vorgabe) oder newest -- der Relay lehnt alles andere ab." },
        limit: { type: "number", description: "Wie viele Zeilen (der Relay deckelt selbst)." },
      },
      required: ["bot_id"],
      additionalProperties: false,
    },
  },
  {
    name: "bot_job",
    description:
      "EIN Lauf mit seinem Ergebnis (GET /v1/bots/:bot/jobs/:job): `status`, `output`, `last_error`. "
      + "Der Weg, den `bot_trigger` als `result_hint` nennt. Nur eigene Laeufe -- ein fremder "
      + "Job antwortet wie ein unbekannter.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "Die bot_id aus bots_list." },
        job_id: { type: "string", description: "Die job_id aus bot_trigger oder bot_jobs." },
      },
      required: ["bot_id", "job_id"],
      additionalProperties: false,
    },
  },
  {
    name: "bot_cancel",
    description:
      "Einen Lauf anhalten (POST /v1/bots/:bot/jobs/:job/cancel). Nicht `failed`: niemand wollte den "
      + "Lauf noch, und ein Fehlschlag waere eine falsche Schuldzuweisung. Ein schon beendeter Lauf "
      + "ist kein Fehler -- die Antwort nennt seinen Zustand (`already: true`). Was der Lauf schon "
      + "getan hat, nimmt niemand zurueck.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "Die bot_id aus bots_list." },
        job_id: { type: "string", description: "Die job_id des Laufs." },
        note: { type: "string", description: "Optionaler Grund, der am Lauf stehen bleibt." },
      },
      required: ["bot_id", "job_id"],
      additionalProperties: false,
    },
  },
];

/** Ein Fehler, den der Aufrufer an seinen Argumenten beheben kann: JSON-RPC -32602. */
class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Der Personen-Token liess sich nicht bauen — kein Netzfehler, keine Werkzeug-Antwort. */
class HelperError extends Error {}

/** Ein Aufruf gegen das Gateway ist nicht zustande gekommen (Netz, Frist, Konfiguration). */
class CallError extends Error {}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Fremdtext hoechstens `max` Zeichen; nie `[object Object]`, nie ein ganzer Rumpf. */
function snippet(text, max = RAW_SNIPPET_MAX) {
  const value = typeof text === "string" ? text : "";
  if (value.length <= max) return value;
  return `${value.slice(0, max)}… (${value.length - max} Zeichen gekürzt)`;
}

function resolveGateway() {
  const raw = (process.env.KWOS_GATEWAY_URL || DEFAULT_GATEWAY).trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { base: null, problem: `KWOS_GATEWAY_URL ist keine gültige URL: ${snippet(raw, 200)}` };
  }
  if (url.protocol !== "https:") {
    return { base: null, problem: `KWOS_GATEWAY_URL muss https sein, nicht ${url.protocol.replace(/:$/, "")}` };
  }
  return { base: raw.replace(/\/+$/, ""), problem: null };
}

const gateway = resolveGateway();

/** stdout ist das Protokoll: genau eine Zeile je Nachricht, nichts sonst. */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function fail(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** Ein Werkzeug-Ergebnis: Text fuer den Agenten, `isError` nur bei einem echten Fehlschlag. */
function toolResult(text, isError = false) {
  const value = typeof text === "string" ? text : String(text);
  const capped = value.length > TOOL_TEXT_MAX
    ? `${value.slice(0, TOOL_TEXT_MAX)}\n… (Text gekürzt: ${value.length - TOOL_TEXT_MAX} Zeichen nicht wiedergegeben)`
    : value;
  return { content: [{ type: "text", text: capped }], isError };
}

/**
 * DIE KOPFZEILEN, die dieses Plugin schon fuer den kw/OS-MCP baut — gefragt, nicht nachgebaut.
 *
 * `mcp-headers.mjs` ist der eine Ort, an dem der Personentoken entsteht (XID-Helfer, kein Browser,
 * ein Login-Weg). Es druckt genau ein JSON-Objekt mit `Authorization` (und `X-KWOS-Workitem`, wenn
 * die Sitzung eines hat); das nimmt dieses MCP woertlich. Damit gibt es keine zweite Token-Quelle
 * und keine zweite Kopie der Plattform-Faelle.
 *
 * Der Helfer laeuft ASYNCHRON: `spawnSync` blockierte die Ereignisschleife, und waehrend eines
 * Werkzeugaufrufs soll `ping` weiter antworten. Gebaut wird der Kopf EINMAL je Werkzeugaufruf.
 */
const headerHelper = fileURLToPath(new URL("./mcp-headers.mjs", import.meta.url));

function runHeaderHelper() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [headerHelper], { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let settled = false;
    let timedOut = false;
    let deadline = null;
    let hardKill = null;

    const clearTimers = () => {
      if (deadline !== null) clearTimeout(deadline);
      if (hardKill !== null) clearTimeout(hardKill);
    };
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimers();
      settle(value);
    };

    deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      hardKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
    }, HELPER_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length <= TOOL_TEXT_MAX) stdout += chunk;
    });
    // Die stderr des Helfers wird gelesen (sonst blockiert die Pipe), aber NIE weitergegeben:
    // dort koennen Tokenreste stehen, und das Werkzeugergebnis landet im Transkript.
    child.stderr.resume();

    child.on("error", (error) => {
      const kind = error?.code ?? error?.message ?? "unbekannt";
      finish(reject, new HelperError(`das Header-Werkzeug konnte nicht gestartet werden (${kind})`));
    });
    child.on("close", (code, signal) => {
      if (timedOut) {
        finish(reject, new HelperError(`das Header-Werkzeug braucht zu lange (Zeitüberschreitung nach ${Math.round(HELPER_TIMEOUT_MS / 1000)} s)`));
      } else if (signal) {
        finish(reject, new HelperError(`das Header-Werkzeug wurde abgebrochen durch ${signal}`));
      } else if (code !== 0) {
        finish(reject, new HelperError(`das Header-Werkzeug endete mit Code ${code}`));
      } else {
        finish(resolve, stdout);
      }
    });
  });
}

/** Nur `Authorization` und `X-KWOS-Workitem` kommen vom Helfer in den Draht. */
function pickHeaders(raw) {
  let parsed = null;
  try {
    parsed = JSON.parse(raw || "");
  } catch {
    parsed = null;
  }
  if (!isObject(parsed)) {
    throw new HelperError("das Header-Werkzeug lieferte kein JSON-Objekt");
  }

  const authorization = parsed.Authorization;
  const bearer = "Bearer ";
  if (typeof authorization !== "string" || !authorization.startsWith(bearer)) {
    throw new HelperError("das Header-Werkzeug lieferte kein Bearer-Token (Authorization fehlt oder ist kein Bearer)");
  }
  const token = authorization.slice(bearer.length);
  if (token.trim() === "" || !/^[\x21-\x7e]+$/.test(token)) {
    throw new HelperError("das Header-Werkzeug lieferte kein brauchbares Bearer-Token (leer oder mit unerlaubten Zeichen)");
  }

  const headers = { Authorization: authorization };
  const workitem = parsed["X-KWOS-Workitem"];
  if (typeof workitem === "string" && workitem.trim() !== "") {
    const value = workitem.trim();
    if (!/^[\x21-\x7e]+$/.test(value)) {
      throw new HelperError("das Header-Werkzeug lieferte ein unbrauchbares X-KWOS-Workitem");
    }
    headers["X-KWOS-Workitem"] = value;
  }
  return headers;
}

/** Einmal je Werkzeugaufruf; die Kopfzeilen gehen als Parameter in `call()`. */
async function buildHeaders() {
  return pickHeaders(await runHeaderHelper());
}

function describeFetchError(error, method, path) {
  const seconds = Math.round(HTTP_TIMEOUT_MS / 1000);
  if (error?.name === "TimeoutError") return `${method} ${path}: Zeitüberschreitung nach ${seconds} s`;
  if (error?.name === "AbortError") return `${method} ${path}: abgebrochen`;
  const cause = error?.cause;
  const reason = cause?.code ?? cause?.message ?? error?.message ?? "unbekannt";
  return `${method} ${path}: Netzwerkfehler (${reason}); Frist ${seconds} s`;
}

function combineSignals(cancelSignal) {
  const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS);
  if (!cancelSignal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([timeout, cancelSignal]);
  return timeout;
}

async function call(method, path, headers, body, cancelSignal, deps = {}) {
  if (gateway.base === null) throw new CallError(gateway.problem);

  const sent = body === undefined
    ? { ...headers }
    : { ...headers, "content-type": "application/json" };

  // DER TRANSPORT IST EINSPEISBAR, sonst nichts: Tests ersetzen `fetch`, nie die Regel.
  const fetchImpl = deps.fetchImpl ?? fetch;
  let answer;
  try {
    answer = await fetchImpl(`${gateway.base}${path}`, {
      method,
      headers: sent,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: combineSignals(cancelSignal),
    });
  } catch (error) {
    throw new CallError(describeFetchError(error, method, path));
  }

  let raw;
  try {
    raw = await answer.text();
  } catch (error) {
    throw new CallError(describeFetchError(error, method, path));
  }

  let parsed = null;
  try {
    parsed = raw === "" ? null : JSON.parse(raw);
  } catch {
    parsed = null;
  }
  return { status: answer.status, ok: answer.ok, body: parsed, raw };
}

function stringField(value) {
  return typeof value === "string" ? value : "";
}

/** Die Absage des Relays, so wie sie kam — ein 4xx ist eine Antwort, kein Absturz. */
function relayRefusal(where, answer, suffix = "") {
  const body = isObject(answer.body) ? answer.body : {};
  const rawText = typeof answer.raw === "string" ? answer.raw : "";
  const explicit = stringField(body.error) || stringField(body.message) || stringField(body.reason);

  let text;
  if (explicit !== "") {
    text = snippet(explicit);
  } else if (rawText.trim() === "") {
    text = "(der Relay schickte keinen Text)";
  } else if (rawText.trimStart().startsWith("<")) {
    text = "(die Antwort war HTML und wird nicht wiedergegeben)";
  } else {
    text = snippet(rawText);
  }

  const detail = stringField(body.reason);
  const extra = detail !== "" && detail !== explicit ? ` (${snippet(detail, 200)})` : "";
  return toolResult(`${where}: der Relay lehnt ab (HTTP ${answer.status}): ${text}${extra}${suffix}`, true);
}

/** Ein Aufruf, der nicht werfen soll: das Ergebnis traegt entweder die Antwort oder den Grund. */
async function attempt(method, path, headers, cancelSignal, deps = {}) {
  try {
    return { answer: await call(method, path, headers, undefined, cancelSignal, deps) };
  } catch (error) {
    return { error };
  }
}

function failureReason(attempted, method, path) {
  if (attempted.answer) return `HTTP ${attempted.answer.status}`;
  if (attempted.error instanceof CallError) return attempted.error.message;
  return `${method} ${path}: ${attempted.error?.message ?? "unbekannter Fehler"}`;
}

const AUTH_STATUS = new Set([401, 403]);

/** Bots aus einem Rumpf, der ein `bots`-Array traegt; eine kaputte Zeile wird uebersprungen. */
function botRows(payload) {
  if (!isObject(payload) || !Array.isArray(payload.bots)) return null;
  return payload.bots.filter(isObject);
}

async function botsList(headers, cancelSignal, deps = {}) {
  const [ownTry, managedTry] = await Promise.all([
    attempt("GET", "/v1/bots", headers, cancelSignal, deps),
    attempt("GET", "/v1/me/managed-bots", headers, cancelSignal, deps),
  ]);

  // 401/403 sind keine halbe Liste wert: ohne Person gibt es nichts zu lesen.
  if (ownTry.answer && AUTH_STATUS.has(ownTry.answer.status)) {
    return relayRefusal("die eigenen Bots lesen", ownTry.answer);
  }
  if (managedTry.answer && AUTH_STATUS.has(managedTry.answer.status)) {
    return relayRefusal("den Katalog lesen", managedTry.answer);
  }

  const notes = [];

  let ownBots = null;
  if (ownTry.answer?.ok) {
    ownBots = botRows(ownTry.answer.body);
    if (ownBots === null) {
      notes.push(`die Antwort der eigenen Bot-Liste war nicht lesbar (HTTP ${ownTry.answer.status}, kein \`bots\`-Array); die eigenen Bots fehlen`);
    }
  } else {
    notes.push(`die eigenen Bots konnte ich nicht lesen (${failureReason(ownTry, "GET", "/v1/bots")})`);
  }

  let managedBots = null;
  if (managedTry.answer?.status === 404) {
    notes.push("der Relay kennt keinen Katalog (HTTP 404); die Liste enthält nur die eigenen Bots");
  } else if (managedTry.answer?.ok) {
    managedBots = botRows(managedTry.answer.body);
    if (managedBots === null) {
      notes.push(`die Antwort des Katalogs war nicht lesbar (HTTP ${managedTry.answer.status}, kein \`bots\`-Array); die Katalog-Bots fehlen`);
    }
  } else {
    notes.push(`den Katalog konnte ich nicht lesen (${failureReason(managedTry, "GET", "/v1/me/managed-bots")})`);
  }

  if (ownBots === null && managedBots === null) {
    return toolResult(["Keine Bot-Liste lesbar.", ...notes].join("\n"), true);
  }

  const rows = [];
  for (const bot of ownBots ?? []) rows.push({ ...bot, origin: "own" });
  for (const row of managedBots ?? []) {
    // Der Katalog nennt die Kennung `bot`; die Liste fuehrt sie unter `bot_id`, wie die Route sie
    // erwartet. Nichts wird umbenannt, was schon so heisst. `bot_id` und `origin` stehen NACH dem
    // Spread, damit die Gegenstelle die Herkunft nicht ueberschreiben kann.
    const { bot, ...rest } = row;
    rows.push({ ...rest, bot_id: bot, origin: "managed" });
  }

  return toolResult(JSON.stringify({ count: rows.length, bots: rows, notes }, null, 2));
}

/** Prueft die Trigger-Argumente VOR jedem URL-Bau und liefert den fertigen Rumpf. */
function triggerRequest(args) {
  if (!isObject(args)) {
    throw new ProtocolError(-32602, "bot_trigger: `arguments` muss ein Objekt mit `bot_id` und `prompt` sein.");
  }

  const rawBotId = args.bot_id;
  if (typeof rawBotId !== "string" || rawBotId.trim() === "") {
    throw new ProtocolError(-32602, "bot_trigger braucht eine bot_id aus bots_list.");
  }
  const botId = rawBotId.trim();
  if (!ID_PATTERN.test(botId)) {
    throw new ProtocolError(-32602, "bot_trigger: die bot_id hat ein unzulässiges Format (erlaubt: [A-Za-z0-9] am Anfang, danach [A-Za-z0-9._-], höchstens 200 Zeichen).");
  }

  const prompt = args.prompt;
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new ProtocolError(-32602, "bot_trigger braucht einen Auftrag (prompt, 1..65536 Zeichen).");
  }
  if (prompt.length > PROMPT_MAX) {
    throw new ProtocolError(-32602, `bot_trigger: der prompt ist zu lang (${prompt.length} Zeichen, erlaubt sind 1..${PROMPT_MAX}).`);
  }

  let jobId;
  if (args.job_id !== undefined) {
    if (typeof args.job_id !== "string") {
      throw new ProtocolError(-32602, "bot_trigger: job_id muss ein String sein.");
    }
    jobId = args.job_id.trim();
    if (jobId === "") {
      throw new ProtocolError(-32602, "bot_trigger: job_id ist leer; weglassen vergibt eine UUID, ein leerer Wert ist kein Idempotenzschlüssel.");
    }
    if (!ID_PATTERN.test(jobId)) {
      throw new ProtocolError(-32602, "bot_trigger: die job_id hat ein unzulässiges Format (erlaubt: [A-Za-z0-9] am Anfang, danach [A-Za-z0-9._-], höchstens 200 Zeichen).");
    }
  } else {
    jobId = randomUUID();
  }

  const body = { job_id: jobId, prompt };
  for (const key of ["kind", "workitem", "automation_id"]) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw new ProtocolError(-32602, `bot_trigger: ${key} muss ein String sein.`);
    }
    const trimmed = value.trim();
    if (trimmed !== "") body[key] = trimmed;
  }

  return { botId, jobId, body };
}

async function botTrigger(request, headers, cancelSignal, deps = {}) {
  const { botId, jobId, body } = request;
  const path = `/v1/bots/${encodeURIComponent(botId)}/jobs`;
  const resultHint = `Das Ergebnis steht später an GET /v1/bots/${botId}/jobs/${jobId} (output).`;

  let answer;
  try {
    answer = await call("POST", path, headers, body, cancelSignal, deps);
  } catch (error) {
    const reason = error instanceof CallError
      ? error.message
      : `der Aufruf ist gescheitert (${error?.message ?? "unbekannt"})`;
    return toolResult(JSON.stringify({
      created: null,
      job_id: jobId,
      line: `Der Relay war nicht erreichbar; ob der Lauf eingeplant wurde, ist offen. ${reason}`,
      retry_hint: "Ein Retry mit DERSELBEN job_id legt keinen zweiten Lauf an.",
      result_hint: resultHint,
    }, null, 2), true);
  }

  if (!answer.ok) {
    return relayRefusal(
      "der Auftrag",
      answer,
      `\njob_id: ${jobId} (ein Retry mit diesem Wert ist kein zweiter Lauf)`,
    );
  }

  const payload = isObject(answer.body) ? answer.body : null;
  const job = isObject(payload?.job) ? payload.job : null;
  const created = payload?.created;

  // Drei Faelle, nicht zwei: `created` fehlt auch dann, wenn der Rumpf gar nicht lesbar war
  // (200/204 mit HTML). Aus „nicht true" auf eine Wiederholung zu schliessen, war falsch.
  if (created !== true && created !== false) {
    return toolResult(JSON.stringify({
      created: null,
      job_id: typeof job?.job_id === "string" ? job.job_id : jobId,
      line: `Antwort des Relays nicht lesbar (HTTP ${answer.status}) — ob der Lauf eingeplant wurde, ist offen.`,
      retry_hint: "Ein Retry mit DERSELBEN job_id legt keinen zweiten Lauf an.",
      result_hint: resultHint,
    }, null, 2), true);
  }

  // Ein zweiter Aufruf mit derselben job_id ist KEIN Fehler und kein zweiter Lauf -- das steht hier
  // als eigener Satz, sonst liest sich die Wiederholung wie ein neuer Start.
  const line = created
    ? "Lauf eingeplant."
    : "Diesen Auftrag gab es schon (gleiche job_id) — es wurde KEIN zweiter Lauf gestartet.";
  return toolResult(JSON.stringify({
    created,
    line,
    job_id: typeof job?.job_id === "string" ? job.job_id : jobId,
    status: typeof job?.status === "string" ? job.status : null,
    job,
    result_hint: resultHint,
  }, null, 2));
}

/** Eine Kennung aus den Argumenten, geprueft bevor sie in einen Pfad wandert. */
function idArg(tool, args, key) {
  const value = args?.[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProtocolError(-32602, `${tool} braucht \`${key}\` (aus bots_list bzw. bot_trigger).`);
  }
  const id = value.trim();
  if (!ID_PATTERN.test(id)) {
    throw new ProtocolError(-32602, `${tool}: \`${key}\` hat ein unzaelaessiges Format (erlaubt: [A-Za-z0-9] am Anfang, danach [A-Za-z0-9._-], hoechstens 200 Zeichen).`);
  }
  return id;
}

/** Die Abfrage der Lauf-Liste, als Query gebaut -- ein Wert, der nicht passt, wird nicht geraten. */
function jobsQuery(args) {
  const query = new URLSearchParams();
  for (const key of ["status", "job_id", "order"]) {
    const value = args?.[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim() === "") {
      throw new ProtocolError(-32602, `bot_jobs: \`${key}\` muss ein nicht-leerer String sein.`);
    }
    query.set(key, value.trim());
  }
  if (args?.limit !== undefined) {
    if (!Number.isInteger(args.limit) || args.limit <= 0) {
      throw new ProtocolError(-32602, "bot_jobs: `limit` muss eine ganze Zahl groesser 0 sein.");
    }
    query.set("limit", String(args.limit));
  }
  const text = query.toString();
  return text === "" ? "" : `?${text}`;
}

/** Eine Antwort, die ein Array traegt, unveraendert weitergeben; sonst der Rumpf als Text. */
function payloadText(answer) {
  const body = isObject(answer.body) ? answer.body : null;
  if (body === null) {
    return snippet(typeof answer.raw === "string" ? answer.raw : "");
  }
  return JSON.stringify(body, null, 2);
}

async function botJobs(args, headers, cancelSignal, deps = {}) {
  const botId = idArg("bot_jobs", args, "bot_id");
  const path = `/v1/bots/${encodeURIComponent(botId)}/jobs${jobsQuery(args)}`;
  const answer = await call("GET", path, headers, undefined, cancelSignal, deps);
  if (!answer.ok) return relayRefusal("die Laeufe", answer);
  return toolResult(payloadText(answer));
}

async function botJob(args, headers, cancelSignal, deps = {}) {
  const botId = idArg("bot_job", args, "bot_id");
  const jobId = idArg("bot_job", args, "job_id");
  const path = `/v1/bots/${encodeURIComponent(botId)}/jobs/${encodeURIComponent(jobId)}`;
  const answer = await call("GET", path, headers, undefined, cancelSignal, deps);
  if (!answer.ok) return relayRefusal("der Lauf", answer);
  return toolResult(payloadText(answer));
}

async function botCancel(args, headers, cancelSignal, deps = {}) {
  const botId = idArg("bot_cancel", args, "bot_id");
  const jobId = idArg("bot_cancel", args, "job_id");
  const body = {};
  if (args?.note !== undefined) {
    if (typeof args.note !== "string") {
      throw new ProtocolError(-32602, "bot_cancel: `note` muss ein String sein.");
    }
    if (args.note.trim() !== "") body.note = args.note.trim();
  }
  const path = `/v1/bots/${encodeURIComponent(botId)}/jobs/${encodeURIComponent(jobId)}/cancel`;
  const answer = await call("POST", path, headers, body, cancelSignal, deps);
  if (!answer.ok) return relayRefusal("das Anhalten", answer);
  const payload = isObject(answer.body) ? answer.body : null;
  const already = payload?.already === true;
  return toolResult(JSON.stringify({
    ok: payload?.ok !== false,
    already,
    line: already
      ? "Der Lauf war schon zu Ende -- kein zweiter Abbruch, sondern sein Zustand."
      : "Der Lauf ist angehalten. Was er schon getan hat, bleibt getan.",
    job: isObject(payload?.job) ? payload.job : null,
  }, null, 2));
}

async function callTool(name, args, cancelSignal, deps = {}) {
  /** Der Personen-Kopf: im Betrieb vom Helfer, im Test eingespeist -- die Route bleibt dieselbe. */
  const head = async () => deps.headers ?? await buildHeaders();
  if (name === "bots_list") {
    if (args !== undefined && (!isObject(args) || Object.keys(args).length > 0)) {
      throw new ProtocolError(-32602, "bots_list nimmt keine Argumente.");
    }
    return await botsList(await head(), cancelSignal, deps);
  }
  if (name === "bot_trigger") {
    // Argumente zuerst: ein ungueltiger Aufruf startet keinen Header-Helfer.
    const request = triggerRequest(args);
    return await botTrigger(request, await head(), cancelSignal, deps);
  }
  if (name === "bot_jobs" || name === "bot_job" || name === "bot_cancel") {
    // Dieselbe Reihenfolge: erst die Argumente pruefen, dann den Personen-Token holen.
    if (name === "bot_jobs") {
      idArg(name, args, "bot_id");
      jobsQuery(args);
    } else {
      idArg(name, args, "bot_id");
      idArg(name, args, "job_id");
      if (name === "bot_cancel" && args?.note !== undefined && typeof args.note !== "string") {
        throw new ProtocolError(-32602, "bot_cancel: `note` muss ein String sein.");
      }
    }
    const headers = await head();
    if (name === "bot_jobs") return await botJobs(args, headers, cancelSignal, deps);
    if (name === "bot_job") return await botJob(args, headers, cancelSignal, deps);
    return await botCancel(args, headers, cancelSignal, deps);
  }
  throw new ProtocolError(-32602, `unbekanntes Werkzeug: ${String(name)}`);
}

/** Laufende Aufrufe, damit `notifications/cancelled` sie per AbortSignal beenden kann. */
const runningCalls = new Map();

function callKey(id) {
  return `${typeof id}:${String(id)}`;
}

function handleNotification(message) {
  if (message.method === "notifications/cancelled") {
    const params = isObject(message.params) ? message.params : {};
    const controller = runningCalls.get(callKey(params.requestId));
    if (controller) controller.abort();
  }
  // `notifications/initialized` und alles andere: keine Antwort, keine Wirkung.
}

function negotiateProtocol(requested) {
  return typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : PROTOCOL_VERSION;
}

async function handleRequest(message) {
  const hasId = Object.prototype.hasOwnProperty.call(message, "id");
  const id = hasId ? message.id : null;

  // Eine JSON-RPC-id ist eine Zeichenkette, eine Zahl oder null — sonst ist die Nachricht kaputt.
  if (hasId && id !== null && typeof id !== "string" && typeof id !== "number") {
    return fail(null, -32600, "Invalid Request: `id` muss eine Zeichenkette, eine Zahl oder null sein.");
  }

  if (typeof message.method !== "string" || message.method === "") {
    return fail(id, -32600, "Invalid Request: `method` fehlt oder ist kein String.");
  }
  if (!hasId) {
    handleNotification(message);
    return null;
  }

  const params = message.params;
  if (params !== undefined && !isObject(params)) {
    return fail(id, -32602, `${message.method}: \`params\` muss ein Objekt sein.`);
  }

  if (message.method === "initialize") {
    return reply(id, {
      protocolVersion: negotiateProtocol(params?.protocolVersion),
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (message.method === "ping") {
    return reply(id, {});
  }
  if (message.method === "tools/list") {
    return reply(id, { tools: TOOLS });
  }
  if (message.method === "tools/call") {
    if (params === undefined) {
      return fail(id, -32602, "tools/call braucht `params` mit `name` und `arguments`.");
    }
    if (typeof params.name !== "string" || params.name === "") {
      return fail(id, -32602, "tools/call: `params.name` fehlt oder ist kein String.");
    }
    if (params.arguments !== undefined && !isObject(params.arguments)) {
      return fail(id, -32602, "tools/call: `params.arguments` muss ein Objekt sein.");
    }

    const controller = new AbortController();
    const key = callKey(id);
    runningCalls.set(key, controller);
    pending += 1;
    try {
      const result = await callTool(params.name, params.arguments, controller.signal);
      if (controller.signal.aborted) return null;
      return reply(id, result);
    } catch (error) {
      if (controller.signal.aborted) return null;
      if (error instanceof ProtocolError) return fail(id, error.code, error.message);
      if (error instanceof HelperError) {
        return reply(id, toolResult(`kein Personen-Token: ${error.message}`, true));
      }
      return reply(id, toolResult(`der Aufruf ist gescheitert: ${error?.message ?? String(error)}`, true));
    } finally {
      runningCalls.delete(key);
      pending -= 1;
      setImmediate(drain);
    }
  }
  return fail(id, -32601, `unknown method: ${message.method}`);
}

async function handleEntry(message) {
  if (!isObject(message)) {
    // Skalare JSON-Werte (null, true, 3, "x") und verschachtelte Arrays sind keine Nachricht.
    return fail(null, -32600, "Invalid Request: eine JSON-RPC-Nachricht ist ein Objekt.");
  }
  return await handleRequest(message);
}

let lines = null;

function startServer() {
  lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    void handleLine(line);
  });
  process.stdin.on("end", () => {
    closing = true;
    drain();
  });
}

/**
 * Ein laufender Aufruf haelt den Prozess am Leben.
 *
 * WARUM: ein Client, der stdin schliesst, waehrend eine Antwort unterwegs ist (ein Skript, ein
 * Test, ein Abbau), wuerde sonst die Verbindung MITTEN im Auftrag beenden — der Auftrag waere
 * beim Relay angelegt und die Antwort nie gelesen. Erst wenn nichts mehr laeuft, endet der Prozess.
 *
 * WIE: `process.exitCode` setzen und readline schliessen, nicht `process.exit(0)`. Der harte
 * Ausstieg schnitt die letzte Antwort ab (gemessen: 65.536 von 85.969 Byte ueber eine Pipe);
 * ein regulaeres Prozessende liefert die offenen Schreibvorgaenge aus.
 */
let pending = 0;
let closing = false;
let finished = false;

function drain() {
  if (finished || !closing || pending > 0 || lines === null) return;
  finished = true;
  process.exitCode = 0;
  lines.close();
}

async function handleLine(line) {
  const trimmed = line.trim();
  if (trimmed === "") return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    send(fail(null, -32700, "Parse error: die Zeile ist kein JSON."));
    return;
  }

  if (Array.isArray(message)) {
    if (message.length === 0) {
      send(fail(null, -32600, "Invalid Request: ein leerer Batch hat nichts zu beantworten."));
      return;
    }
    const answers = (await Promise.all(message.map((entry) => handleEntry(entry))))
      .filter((entry) => entry !== null);
    if (answers.length > 0) send(answers);
    return;
  }

  const answer = await handleEntry(message);
  if (answer !== null) send(answer);
}

/**
 * NUR BEIM DIREKTSTART LAUSCHEN (WI 11619349). Wird das Modul importiert (Tests), darf es nicht
 * auf stdin warten -- sonst haengt der Testlauf an einem Prozess, der auf Eingaben wartet.
 */
const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href || !existsSync(process.argv[1] ?? "");
  } catch {
    return false;
  }
})();

export { TOOLS, callTool };

if (invokedDirectly) startServer();
