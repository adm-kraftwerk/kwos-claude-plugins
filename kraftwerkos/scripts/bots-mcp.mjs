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
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

import { accessToken } from "./xiam-token.mjs";

const SERVER_NAME = "kwos-bots";
const SERVER_VERSION = "1.0.0";

/** Wohin die Routen gehen. Ueberschreibbar, damit eine Sitzung gegen einen anderen Ring testen kann. */
const GATEWAY = (process.env.KWOS_GATEWAY_URL || "https://llm.os.kraftwerk.io").replace(/\/+$/, "");

/** Ein Aufruf ist ein Auftrag, kein Download; laenger als das ist der Relay nicht erreichbar. */
const HTTP_TIMEOUT_MS = 30_000;

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
];

/** stdout ist das Protokoll: genau eine Zeile je Nachricht, nichts sonst. */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

/** Ein Werkzeug-Ergebnis: Text fuer den Agenten, `isError` nur bei einem echten Fehlschlag. */
function toolResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

/** Der Personen-Token, oder ein Fehlschlag mit Grund (nie der Token selbst in einer Meldung). */
function token() {
  return accessToken((reason) => {
    throw new Error(`kein Personen-Token: ${reason}`);
  });
}

async function call(method, path, body) {
  const headers = { Authorization: `Bearer ${token()}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const workitem = (process.env.KWOS_WORKITEM || "").trim();
  if (workitem !== "") headers["X-KWOS-Workitem"] = workitem;
  const answer = await fetch(`${GATEWAY}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const raw = await answer.text();
  let parsed = null;
  try {
    parsed = raw === "" ? null : JSON.parse(raw);
  } catch {
    parsed = null;
  }
  return { status: answer.status, ok: answer.ok, body: parsed, raw };
}

/** Die Absage des Relays, so wie sie kam — ein 4xx ist eine Antwort, kein Absturz. */
function relayRefusal(where, answer) {
  const reason = answer.body && typeof answer.body === "object" ? answer.body : null;
  const text = reason?.error ?? answer.raw ?? "";
  const extra = reason?.reason !== undefined ? ` (${reason.reason})` : "";
  return toolResult(`${where}: der Relay lehnt ab (HTTP ${answer.status}): ${text}${extra}`, true);
}

async function botsList() {
  const [own, managed] = await Promise.all([
    call("GET", "/v1/bots"),
    call("GET", "/v1/me/managed-bots"),
  ]);
  if (!own.ok) return relayRefusal("die eigenen Bots lesen", own);
  if (!managed.ok && managed.status !== 404) return relayRefusal("den Katalog lesen", managed);

  const rows = [];
  const ownBots = Array.isArray(own.body?.bots) ? own.body.bots : [];
  for (const bot of ownBots) rows.push({ origin: "own", ...bot });
  const managedBots = managed.ok && Array.isArray(managed.body?.bots) ? managed.body.bots : [];
  for (const row of managedBots) {
    // Der Katalog nennt die Kennung `bot`; die Liste fuehrt sie unter `bot_id`, wie die Route sie
    // erwartet. Nichts wird umbenannt, was schon so heisst.
    const { bot, ...rest } = row;
    rows.push({ origin: "managed", bot_id: bot, ...rest });
  }
  const notes = [];
  if (!managed.ok) notes.push("den Katalog konnte ich nicht lesen (HTTP " + managed.status + "); die Liste enthaelt nur die eigenen Bots");
  return toolResult(JSON.stringify({ count: rows.length, bots: rows, notes }, null, 2));
}

async function botTrigger(args) {
  const botId = typeof args?.bot_id === "string" ? args.bot_id.trim() : "";
  const prompt = typeof args?.prompt === "string" ? args.prompt : "";
  if (botId === "") return toolResult("bot_trigger braucht eine bot_id aus bots_list.", true);
  if (prompt.trim() === "") return toolResult("bot_trigger braucht einen Auftrag (prompt).", true);

  const body = { job_id: typeof args?.job_id === "string" && args.job_id.trim() !== "" ? args.job_id.trim() : randomUUID(), prompt };
  for (const key of ["kind", "workitem", "automation_id"]) {
    if (typeof args?.[key] === "string" && args[key].trim() !== "") body[key] = args[key].trim();
  }

  const answer = await call("POST", `/v1/bots/${encodeURIComponent(botId)}/jobs`, body);
  if (!answer.ok) return relayRefusal("der Auftrag", answer);
  const job = answer.body?.job ?? null;
  const created = answer.body?.created === true;
  // Ein zweiter Aufruf mit derselben job_id ist KEIN Fehler und kein zweiter Lauf -- das steht hier
  // als eigener Satz, sonst liest sich die Wiederholung wie ein neuer Start.
  const line = created
    ? "Lauf eingeplant."
    : "Diesen Auftrag gab es schon (gleiche job_id) — es wurde KEIN zweiter Lauf gestartet.";
  return toolResult(JSON.stringify({
    created,
    line,
    job_id: job?.job_id ?? body.job_id,
    status: job?.status ?? null,
    job,
    result_hint: "Das Ergebnis steht spaeter an GET /v1/bots/" + botId + "/jobs/" + (job?.job_id ?? body.job_id) + " (output).",
  }, null, 2));
}

async function callTool(name, args) {
  if (name === "bots_list") return await botsList();
  if (name === "bot_trigger") return await botTrigger(args ?? {});
  return toolResult(`unbekanntes Werkzeug: ${name}`, true);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

/**
 * Ein laufender Aufruf haelt den Prozess am Leben.
 *
 * WARUM: ein Client, der stdin schliesst, waehrend eine Antwort unterwegs ist (ein Skript, ein
 * Test, ein Abbau), wuerde sonst die Verbindung MITTEN im Auftrag beenden — der Auftrag waere
 * beim Relay angelegt und die Antwort nie gelesen. Erst wenn nichts mehr laeuft, endet der Prozess.
 */
let pending = 0;
let closing = false;
function drain() {
  if (closing && pending === 0) process.exit(0);
}

lines.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed === "") return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return; // kein Protokoll, keine Antwort: eine kaputte Zeile ist kein Aufruf
  }
  const { id, method, params } = message ?? {};
  // Benachrichtigungen tragen keine id und bekommen keine Antwort.
  if (id === undefined) return;

  if (method === "initialize") {
    reply(id, {
      protocolVersion: params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }
  if (method === "ping") {
    reply(id, {});
    return;
  }
  if (method === "tools/list") {
    reply(id, { tools: TOOLS });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    pending += 1;
    Promise.resolve()
      .then(() => callTool(name, params?.arguments))
      .then((result) => reply(id, result))
      .catch((error) => {
        // Ein Fehlschlag wird als Werkzeug-Ergebnis gemeldet, nicht als Protokollfehler: der Agent
        // soll den Grund lesen koennen, statt eine abgebrochene Verbindung zu sehen.
        reply(id, toolResult(`der Aufruf ist gescheitert: ${error?.message ?? String(error)}`, true));
      })
      .finally(() => {
        pending -= 1;
        drain();
      });
    return;
  }
  fail(id, -32601, `unknown method: ${method}`);
});

process.stdin.on("end", () => {
  closing = true;
  drain();
});
