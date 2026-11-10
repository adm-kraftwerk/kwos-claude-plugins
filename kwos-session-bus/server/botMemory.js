// A running session's window into its bot's memory (WI 11605710).
//
// WHAT THIS IS: the read side of a bot, plus one deliberate write, over the two gateway routes that
// already exist -- `GET /v1/sessions/:id/bot` (which bot is this session?) and
// `GET`/`POST /v1/bots/:bot/memory`. The HTTP client, the bearer and the error text stay in
// relay-client.js (`call`), exactly as collab.js does it: no second client, no second auth path.
//
// WHAT THIS IS NOT: a second copy of the ownership rule. Every route scopes its statements to the
// caller's XID subject, so the answer can only ever contain this person's entries; the plugin does
// not filter afterwards and must not pretend to.
//
// THE TEXT NEVER LEAVES except in the POST body that stores it, and nothing here logs it. This file
// has no logger on purpose -- there is no line in it that could print a memory entry by accident.

import { config, ensureSessionId } from "./config.js";
import { call } from "./relay-client.js";

export const BOT_MEMORY_TOOLS = [
  {
    name: "bot_memory",
    description:
      "Liest das Gedächtnis des Bots, zu dem DIESE Sitzung gehört (WI 11605710): was dort über " +
      "frühere Sitzungen hinweg gemerkt wurde. Ohne `add` wird nur gelesen -- optional auf eine " +
      "Art (`kind`) eingeschränkt und mit `query` als Suche (Teilzeichenkette, Groß- und " +
      "Kleinschreibung egal). Gehört die Sitzung zu keinem Bot, sagt die Antwort das ausdrücklich; " +
      "das ist der Normalfall einer gewöhnlichen Sitzung und kein Fehler. Mit `add` wird EIN " +
      "Eintrag gespeichert -- ausschließlich, wenn dein Nutzer es ausdrücklich gesagt hat („merk " +
      "dir …“, „notier das“), niemals auf Verdacht und niemals aus dem Gesprächsverlauf geraten. " +
      "Gespeichert wird als Vorschlag dieser Sitzung (`source: session`), damit ein Mensch sieht, " +
      "woher der Text stammt. Vor dem Arbeiten an etwas, das schon einmal entschieden wurde, hier " +
      "nachsehen, bevor du dieselbe Frage noch einmal stellst.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["fact", "work_log"],
          description:
            "Art der Einträge. `fact`: eine bleibende Tatsache (Vorliebe, Entscheidung, " +
            "Projektwissen). `work_log`: was eine Sitzung getan hat und was offen blieb. Ohne " +
            "Angabe beim Lesen beide Arten; beim Speichern ist `fact` die Vorgabe.",
        },
        query: {
          type: "string",
          description:
            "Suchtext für das Lesen: Teilzeichenkette über den Text der Einträge, unabhängig von " +
            "Groß- und Kleinschreibung. Nicht zusammen mit `add`.",
        },
        add: {
          type: "string",
          description:
            "EIN Eintrag, der gespeichert wird -- nur nach ausdrücklichem Wunsch des Nutzers, nie " +
            "auf Verdacht. Den Text so lassen, wie der Nutzer ihn gesagt hat: nicht umformulieren, " +
            "nicht ergänzen, nichts aus dem Gespräch hinzuerfinden. Nicht zusammen mit `query`.",
        },
      },
      additionalProperties: false,
    },
  },
];

export const BOT_MEMORY_TOOL_NAMES = new Set(BOT_MEMORY_TOOLS.map((t) => t.name));

/**
 * GET /v1/sessions/{id}/bot -> `{ session_id, bot_id }`.
 *
 * `bot_id: null` is a deliberate answer (an ordinary session belongs to no bot), so it must stay
 * distinguishable from "the relay said something this client does not know". The caller decides
 * which of the two it has; this function only reports what came back.
 */
export async function sessionBot(sessionId) {
  const { data } = await call(`/v1/sessions/${encodeURIComponent(sessionId)}/bot`);
  return data ?? {};
}

/** GET /v1/bots/{bot}/memory?kind=&q= -- the caller's own live entries, bounded by the relay. */
export async function readBotMemory(botId, { kind, query } = {}) {
  const params = new URLSearchParams();
  if (kind) params.set("kind", kind);
  if (query) params.set("q", query);
  const qs = params.toString();
  const { data } = await call(`/v1/bots/${encodeURIComponent(botId)}/memory${qs ? `?${qs}` : ""}`);
  // A body that is not JSON is not "no entries" -- reading it as an empty list would tell the agent
  // the bot remembers nothing when the relay (or a proxy in front of it) failed to answer.
  if (!data || !Array.isArray(data.entries)) {
    throw new Error(
      "Die Antwort des Relays auf die Gedächtnis-Abfrage war kein lesbares JSON -- vermutlich " +
        "eine Fehlerseite/Proxy-Antwort, nicht ein leeres Gedächtnis."
    );
  }
  return data;
}

/**
 * POST /v1/bots/{bot}/memory -- ONE entry, entered by THIS session.
 *
 * `source: "session"` is the gateway's own distinction (relay/botRules.js): `user` is a person
 * typing, `session` is an agent proposing. A reader needs it to judge how much to trust an entry,
 * so it is recorded and not inferred.
 *
 * The relay owns the limits (text length, fullness, the refusal to re-create a deleted entry) and
 * answers 409/400 with a sentence; that sentence travels on as an error and reaches the model as
 * the relay's refusal. No copy of those rules is kept here.
 */
export async function addBotMemory(botId, { text, kind, sessionId, workitem } = {}) {
  const body = {
    text,
    source: "session",
    ...(kind ? { kind } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(workitem ? { workitem } : {}),
  };
  const { data } = await call(`/v1/bots/${encodeURIComponent(botId)}/memory`, { method: "POST", body });
  if (!data?.entry) {
    throw new Error("Der Relay hat den Eintrag nicht zurückgegeben (unerwartete Antwort).");
  }
  return data.entry;
}

const answer = (t) => ({ content: [{ type: "text", text: t }] });

/** `fact`/`work_log` when given, otherwise undefined -- the relay rejects anything else anyway. */
function chosenKind(raw) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (raw !== "fact" && raw !== "work_log") {
    throw new Error(`kind muss "fact" oder "work_log" sein (erhalten: ${JSON.stringify(raw)}).`);
  }
  return raw;
}

function chosenQuery(raw) {
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  return text === "" ? undefined : text;
}

function scopeSuffix(kind, query) {
  const parts = [kind ? `kind=${kind}` : null, query ? `Suche "${query}"` : null].filter(Boolean);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

export async function handleBotMemoryTool(name, args = {}) {
  if (!BOT_MEMORY_TOOL_NAMES.has(name)) throw new Error(`Unbekanntes Tool: ${name}`);

  // The two argument rules are checked BEFORE the network: a contradictory or empty call is the
  // caller's mistake, and a relay round trip would only turn it into a worse sentence.
  const kind = chosenKind(args.kind);
  const query = chosenQuery(args.query);
  const add = args.add === undefined || args.add === null ? undefined : String(args.add);
  if (add !== undefined) {
    if (add.trim() === "") {
      throw new Error("add ist leer -- ohne Text gibt es nichts zu merken.");
    }
    if (query !== undefined) {
      throw new Error("add und query schließen sich aus: entweder EINEN Eintrag merken oder suchen.");
    }
  }

  // The id this session already has -- the marker, not anything the caller passes. It is also the
  // only id the relay accepts here: `GET /v1/sessions/:id/bot` scopes to the caller's own sessions.
  await ensureSessionId();
  const sessionId = config.sessionId;

  const bot = await sessionBot(sessionId);
  if (bot.bot_id === null) {
    return answer(
      "Diese Sitzung gehört zu keinem Bot -- es gibt kein Gedächtnis, das zu ihr gehört. Das ist " +
        "der Normalfall: nur eine Sitzung, die aus einem Bot gestartet wurde, hat eines."
    );
  }
  if (typeof bot.bot_id !== "string" || bot.bot_id === "") {
    throw new Error(
      "Der Relay hat keinen Bot genannt (unerwartete Antwort auf GET /v1/sessions/:id/bot)."
    );
  }

  if (add !== undefined) {
    const entry = await addBotMemory(bot.bot_id, {
      text: add,
      kind,
      sessionId,
      workitem: config.workitem ?? undefined,
    });
    return answer(
      `Gemerkt als Eintrag ${entry.entry_id}${entry.kind ? ` (${entry.kind})` : ""} von Bot ${bot.bot_id}.`
    );
  }

  const memory = await readBotMemory(bot.bot_id, { kind, query });
  const suffix = scopeSuffix(kind, query);
  if (memory.entries.length === 0) {
    return answer(`Der Bot ${bot.bot_id} hat keine Einträge${suffix}.`);
  }
  const count = memory.entries.length;
  return answer(
    `Gedächtnis von Bot ${bot.bot_id}: ${count} Eintrag${count === 1 ? "" : "e"}${suffix}.\n` +
      JSON.stringify(memory.entries, null, 2)
  );
}
