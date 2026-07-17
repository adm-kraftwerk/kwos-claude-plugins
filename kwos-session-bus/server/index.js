import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config.js";
import { log } from "./log.js";
import * as relay from "./relay-client.js";

const TOOLS = [
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
];

const server = new Server(
  { name: "kwos-session-bus", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
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
      default:
        throw new Error(`Unbekanntes Tool: ${name}`);
    }
  } catch (err) {
    return { content: [{ type: "text", text: `Fehler: ${err.message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (!config.relayUrl) {
    log.error("Kein KWOS_RELAY_URL — Tools sind registriert, Relay-Calls schlagen fehl.");
    return;
  }

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

main().catch((err) => {
  log.error("Unerwarteter Fehler beim Start.", { error: String(err) });
  process.exit(1);
});
