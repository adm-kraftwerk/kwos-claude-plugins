import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { config, ensureSessionId } from "./config.js";
import { log } from "./log.js";
import * as relay from "./relay-client.js";

export const TOOLS = [
  {
    name: "list_sessions",
    description: "Listet aktive kw/OS-Session-Bus-Sessions (gleicher User/Team) auf.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "send_message",
    description: "Sendet eine Nachricht an eine bestimmte Session über den kw/OS Session Relay.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "session_id oder display_name der Zielsession" },
        text: { type: "string" },
        workitem_ref: { type: "string", description: "Optional: zugehörige kw/OS-Workitem-ID" },
      },
      required: ["target", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "broadcast",
    description: "Sendet eine Nachricht an alle eigenen aktiven Sessions.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        workitem_ref: { type: "string", description: "Optional: zugehörige kw/OS-Workitem-ID" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "notify_dependents",
    description:
      "Benachrichtigt ALLE Sessions (auch fremder Nutzer/Teams), die einen bestimmten Channel " +
      "abonniert haben, über eine Änderung, die sie betreffen könnte -- z. B. eine geänderte " +
      "Schnittstelle/einen geänderten Contract zwischen zwei Services. Ein Channel entspricht " +
      "typischerweise einem Repo-/Service-Namen: jede Session hört per Default auf den Namen " +
      "ihres eigenen Arbeitsverzeichnisses. Zum Erreichen einer bestimmten abhängigen Session " +
      "reicht es also, deren Repo-/Service-Namen zu kennen -- nicht ihre Session-ID.",
    inputSchema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: "Ziel-Channel, typischerweise der Repo-/Service-Name der abhängigen Session",
        },
        summary: {
          type: "string",
          description: "Was sich geändert hat und was die betroffene Session ggf. anpassen muss",
        },
        workitem_ref: { type: "string", description: "Optional: zugehörige kw/OS-Workitem-ID" },
      },
      required: ["channel", "summary"],
      additionalProperties: false,
    },
  },
  {
    name: "ask_remote",
    description:
      "Stellt eine Rückfrage an den Menschen über den kw/OS Remote-Control-Kanal (PWA/Push) -- " +
      "für Momente, in denen eine Entscheidung nötig ist, aber niemand am Terminal sitzt (nicht " +
      "auf Tool-Freigaben beschränkt, z. B. eine fachliche Zwischenfrage). Wartet bis zu ~9,5 " +
      "Minuten auf eine Antwort; kommt keine, meldet das Tool das klar zurück, statt unbegrenzt " +
      "zu blockieren -- dann selbst sinnvoll weiterarbeiten oder den Nutzer im Terminal fragen.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Optionale Antwortmöglichkeiten (Multiple-Choice); ohne Angabe kann frei geantwortet werden",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
  {
    name: "get_attachment",
    description:
      "Löst eine attachment_id (steckt im Notification-Hinweis einer eingegangenen Nachricht, " +
      "wenn ein Bild angehängt ist) in einen echten Bild-Content-Block auf -- NICHT als " +
      "Base64-Text, ein Sprachmodell sieht rohen Base64 nicht als Bild. Nur aufrufen, wenn die " +
      "Session sich entscheidet, ein angekündigtes Bild tatsächlich anzusehen.",
    inputSchema: {
      type: "object",
      properties: {
        attachment_id: { type: "string", description: "UUID aus dem attachment_id-Feld der Notification" },
      },
      required: ["attachment_id"],
      additionalProperties: false,
    },
  },
];

const server = new Server(
  { name: "kwos-session-bus", version: "0.3.4" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// Reine Dispatch-Logik, getrennt von der stdio/MCP-Verdrahtung (gleiches Prinzip wie
// lib.js/server.js im litellm-Repo) -- so testbar ohne Server/Transport hochzufahren.
// Wirft bei Fehlern normal, statt sie selbst in ein isError-Content-Objekt zu verpacken --
// das macht callTool() unten, damit ein Test hier den ECHTEN Fehler sieht (Message/Typ),
// nicht nur eine bereits zu Text geschrumpfte Fehlermeldung.
export async function handleToolCall(name, args = {}) {
  switch (name) {
    case "list_sessions": {
      const sessions = await relay.listSessions();
      return { content: [{ type: "text", text: JSON.stringify(sessions, null, 2) }] };
    }
    case "send_message": {
      const { target, text, workitem_ref } = args;
      const result = await relay.sendMessage(target, text, workitem_ref);
      const status = result.delivered ? "zugestellt" : "eingereiht (Zielsession offline)";
      return { content: [{ type: "text", text: `Nachricht ${status}.` }] };
    }
    case "broadcast": {
      await relay.broadcast(args.text, args.workitem_ref);
      return { content: [{ type: "text", text: "Broadcast gesendet." }] };
    }
    case "notify_dependents": {
      const { channel, summary, workitem_ref } = args;
      const result = await relay.publishToChannel(channel, summary, workitem_ref);
      return {
        content: [{ type: "text", text: `An ${result.fanout} Session(en) im Channel "${channel}" gesendet.` }],
      };
    }
    case "ask_remote": {
      const { question, options } = args;
      const result = await relay.askRemote(question, options);
      const text = result.status === "answered"
        ? `Antwort erhalten: ${result.answer}`
        : "Keine Antwort erhalten (Zeitfenster abgelaufen). Bitte selbst sinnvoll entscheiden " +
          "oder den Nutzer im Terminal direkt fragen.";
      return { content: [{ type: "text", text }] };
    }
    case "get_attachment": {
      const { mimeType, data } = await relay.getAttachment(args.attachment_id);
      return { content: [{ type: "image", data, mimeType }] };
    }
    default:
      throw new Error(`Unbekanntes Tool: ${name}`);
  }
}

export async function callTool(request) {
  const { name, arguments: args = {} } = request.params;
  try {
    return await handleToolCall(name, args);
  } catch (err) {
    return { content: [{ type: "text", text: `Fehler: ${err.message}` }], isError: true };
  }
}

server.setRequestHandler(CallToolRequestSchema, callTool);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  await ensureSessionId();
  try {
    await relay.register();
    log.info("Bei Session Relay registriert.", { sessionId: config.sessionId });
  } catch (err) {
    log.error("Registrierung fehlgeschlagen.", { error: String(err) });
  }

  const heartbeatTimer = setInterval(() => {
    relay.heartbeat().catch((err) => log.error("Heartbeat fehlgeschlagen.", { error: String(err) }));
  }, config.heartbeatIntervalMs);
  heartbeatTimer.unref();

  // SSE-Empfang läuft nicht mehr hier, sondern als separater Background-Monitor
  // (monitors/monitors.json -> server/listen.js) — siehe Workitem-9831620-Kommentar
  // vom 2026-07-16 zum offiziellen `monitors`-Manifest-Key.
}

// Nur beim direkten Start ausführen (node server/index.js bzw. das gebündelte .mjs), NICHT
// beim `import` aus einem Test -- sonst würde jeder Test, der TOOLS/handleToolCall importiert,
// unbeabsichtigt einen echten stdio-Server verbinden und sich beim Relay registrieren.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    log.error("Unerwarteter Fehler beim Start.", { error: String(err) });
    process.exit(1);
  });
}
