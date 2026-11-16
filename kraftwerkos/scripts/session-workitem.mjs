#!/usr/bin/env node
/**
 * session-workitem.mjs — welchem kw/OS-Workitem DIESE Sitzung zugerechnet wird, und der Wechsel
 * (WI 11628405).
 *
 * WOZU. Der Wechsel existiert seit 2026-08-05 als Prompt-Befehl `@LLMGW WI:<id>` am Zeilenanfang:
 * ein http-Hook faengt die Zeile ab, bevor das Modell sie sieht. Fuer einen Agenten ist das eine
 * Umleitung durch den Menschen. Die Route bietet den Wechsel laengst auch als direkte JSON-API an
 * (`POST /v1/session-workitem` mit `{session_id, workitem}`, Auth per `X-KWOS-Switch-Token`) --
 * dieses MCP wrappt GENAU sie, es erfindet keine zweite Route und keine zweite Berechtigung.
 *
 * DIE DREI DINGE, DIE ES NICHT SELBST ERFINDET:
 *   * die Sitzungs-ID -- `CLAUDE_CODE_SESSION_ID` aus der Umgebung (gemessen 2026-11-16: identisch
 *     mit `attribution.sessions.session_id`);
 *   * die Berechtigung -- `KWOS_SWITCH_TOKEN`, vom Launcher exportiert;
 *   * die Sperre -- das Token ist beim ersten Gebrauch an GENAU EINE Sitzung gebunden und die Route
 *     weist jede andere ab (403 `token_session_mismatch`). Deshalb gibt es hier keinen Parameter
 *     fuer die Sitzung: was das Werkzeug umbuchen kann, ist immer nur die eigene.
 *
 * WAS JEDE ANTWORT SAGT, weil es sonst falsch verstanden wird: der Wechsel gilt ab dem NAECHSTEN
 * Request. Bis dahin gebuchte Kosten bleiben beim alten Workitem -- nachtraeglich umbuchen kann
 * niemand, LiteLLM rechnet je Key-Zeile ab.
 *
 * PROTOKOLL: MCP ueber stdio, zeilenweise JSON-RPC 2.0 -- dieselbe Transportform wie
 * `bots-mcp.mjs`, ohne SDK (das Plugin hat bewusst keine Abhaengigkeiten). Auf stdout steht NUR das
 * Protokoll; alles andere geht auf stderr.
 */
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const SERVER_NAME = "kwos-session-workitem";
const SERVER_VERSION = "1.0.0";

/** Wohin die Route geht. Ueberschreibbar, damit eine Sitzung gegen einen anderen Ring testen kann. */
const DEFAULT_GATEWAY = "https://llm.os.kraftwerk.io";

/** Ein Wechsel ist ein einzelner Aufruf; laenger als das ist das Gateway nicht erreichbar. */
const HTTP_TIMEOUT_MS = 10_000;

export const TOOLS = [
  {
    name: "session_workitem",
    description:
      "Zeigt, welchem kw/OS-Workitem DIESE Sitzung gerade zugerechnet wird, und ob sie wechseln " +
      "darf (Switch-Token vorhanden). Reine Auskunft, kein Netzzugriff.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "switch_workitem",
    description:
      "Bucht DIESE Sitzung auf ein anderes kw/OS-Workitem um -- dieselbe Wirkung wie der Befehl " +
      "'@LLMGW WI:<id>' am Zeilenanfang. Ab dem NAECHSTEN Request wird auf das neue Workitem " +
      "gebucht; was bis dahin gebucht wurde, bleibt beim alten (eine rueckwirkende Umbuchung gibt " +
      "es nicht). Nur die eigene Sitzung und nur eigene Workitems: die Berechtigung ist das " +
      "Switch-Token der Sitzung, nicht dieser Aufruf. Nimm das Werkzeug, wenn dein Nutzer sagt, " +
      "wofuer die Arbeit jetzt gehoert -- nicht auf Verdacht.",
    inputSchema: {
      type: "object",
      properties: {
        workitem: { type: "string", description: "kw/OS-Workitem-Nummer, z. B. \"11605710\"" },
      },
      required: ["workitem"],
      additionalProperties: false,
    },
  },
];

const text = (s) => ({ content: [{ type: "text", text: s }] });

function shortSession(sid) {
  const s = String(sid || "");
  return s ? s.slice(0, 8) : "(keine Sitzungs-ID in der Umgebung)";
}

/** Nur https -- ausser fuer lokale Testlaeufe (http://127.0.0.1, http://localhost). */
function gatewayBase(env) {
  const raw = String(env.KWOS_GATEWAY_URL || DEFAULT_GATEWAY).replace(/\/+$/, "");
  if (/^https:\/\//i.test(raw) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(raw)) return raw;
  return "";
}

/**
 * Die Werkzeuge, ohne Transport -- so testbar ohne Server hochzufahren. Gibt IMMER ein
 * Werkzeugergebnis zurueck (nie eine Ausnahme): ein Agent, der eine Exception bekommt, versucht es
 * wieder, und ein zweiter Versuch ist ein zweiter Wechselversuch.
 */
export async function handleTool(name, args = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const sessionId = String(deps.sessionId ?? env.CLAUDE_CODE_SESSION_ID ?? "").trim();
  const switchToken = String(env.KWOS_SWITCH_TOKEN ?? "").trim();
  const current = String(env.KWOS_WORKITEM ?? "").trim();

  if (name === "session_workitem") {
    return text(
      [
        `Sitzung ${shortSession(sessionId)}`,
        `Workitem: ${current || "(unbekannt -- der Launcher hat KWOS_WORKITEM nicht gesetzt)"}`,
        switchToken
          ? "Wechsel moeglich (Switch-Token vorhanden)."
          : "Wechsel NICHT moeglich: kein Switch-Token in dieser Sitzung (KWOS_SWITCH_TOKEN fehlt).",
      ].join("\n"),
    );
  }
  if (name !== "switch_workitem") return null;

  const wanted = String(args.workitem ?? "").trim();
  if (!/^\d{1,12}$/.test(wanted)) {
    return text(`Kein gueltiges Workitem: "${wanted}". Erwartet wird die Ziffernfolge der kw/OS-Workitem-Nummer.`);
  }
  if (!switchToken) {
    return text(
      "Diese Sitzung hat kein Switch-Token (KWOS_SWITCH_TOKEN fehlt) -- ein Wechsel ist nicht moeglich. " +
        `Ein Mensch kann '@LLMGW WI:${wanted}' am Zeilenanfang tippen, oder die Sitzung mit einem frischen ` +
        "Token neu starten. Das Workitem wurde NICHT gewechselt.",
    );
  }
  const base = gatewayBase(env);
  if (base === "") {
    return text(
      `Die Gateway-Adresse ist unbrauchbar (${env.KWOS_GATEWAY_URL || "(leer)"}) -- erwartet wird https://… . ` +
        "Das Workitem wurde NICHT gewechselt.",
    );
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  let res;
  try {
    res = await fetchImpl(`${base}/v1/session-workitem`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-KWOS-Switch-Token": switchToken },
      body: JSON.stringify({ session_id: sessionId, workitem: wanted }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? HTTP_TIMEOUT_MS),
    });
  } catch (e) {
    // KEIN Retry: der erste Versuch koennte serverseitig schon gegriffen haben.
    return text(
      `Der Wechsel konnte nicht zugestellt werden (${e?.message ?? e}). Das Workitem wurde NICHT gewechselt -- ` +
        `bitte erneut versuchen oder '@LLMGW WI:${wanted}' tippen.`,
    );
  }

  const raw = await res.text().catch(() => "");
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    /* bleibt Text */
  }
  const reason = typeof body?.error === "string" && body.error ? body.error : String(raw || "").slice(0, 200);

  if (res.status === 200) {
    const from = String(body?.from ?? current ?? "");
    const to = String(body?.to ?? wanted);
    if (body?.changed === false) return text(`Die Sitzung steht bereits auf Workitem ${to}. Nichts umgebucht.`);
    return text(
      `Sitzung ${shortSession(sessionId)} bucht jetzt auf Workitem ${to}` +
        (from && from !== to ? ` (vorher ${from})` : "") +
        ". Das gilt ab dem NAECHSTEN Request; was bis dahin gebucht wurde, bleibt beim alten Workitem.",
    );
  }
  if (res.status === 401) {
    return text(
      `Das Switch-Token dieser Sitzung ist nicht (mehr) gueltig (${reason || "401"}). Das Workitem wurde NICHT ` +
        `gewechselt -- ein Mensch kann '@LLMGW WI:${wanted}' tippen, oder die Sitzung neu starten.`,
    );
  }
  if (res.status === 403 && body?.code === "token_session_mismatch") {
    return text("Dieses Switch-Token gehoert einer anderen Sitzung -- der Wechsel wurde abgelehnt. Das Workitem wurde NICHT gewechselt.");
  }
  if (res.status === 403) {
    return text(`Workitem ${wanted} ist fuer diese Sitzung nicht bebuchbar: ${reason || "abgelehnt"}. Das Workitem wurde NICHT gewechselt.`);
  }
  return text(`Der Wechsel wurde abgelehnt (HTTP ${res.status}): ${reason || "ohne Begruendung"}. Das Workitem wurde NICHT gewechselt.`);
}

// ── Transport: zeilenweises JSON-RPC 2.0 auf stdio ─────────────────────────────────────────────

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const ok = (id, result) => write({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });

async function onMessage(msg) {
  const { id, method, params } = msg ?? {};
  if (method === "initialize") {
    return ok(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === "tools/list") return ok(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (!TOOLS.some((t) => t.name === name)) return fail(id, -32602, `unknown tool: ${name}`);
    const result = await handleTool(name, args);
    return ok(id, result);
  }
  if (typeof method === "string" && method.startsWith("notifications/")) return; // keine Antwort
  if (id !== undefined) return fail(id, -32601, `unknown method: ${method}`);
}

export function startServer(input = process.stdin) {
  const rl = createInterface({ input });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (e) {
      fail(null, -32700, `parse error: ${e?.message ?? e}`);
      return;
    }
    onMessage(msg).catch((e) => fail(msg?.id ?? null, -32603, `internal error: ${e?.message ?? e}`));
  });
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href || !existsSync(process.argv[1] ?? "");
  } catch {
    return false;
  }
})();

if (invokedDirectly) startServer();
