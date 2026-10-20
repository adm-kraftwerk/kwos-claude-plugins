import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { config, ensureSessionId, refreshSessionId } from "./config.js";
import { log } from "./log.js";
import * as relay from "./relay-client.js";
import * as collab from "./collab.js";
// The channel's release question has ONE answer in this plugin, and it is read where the receive
// path reads it (collab-listen.js, `collabReleased`): the launcher exports it, so the tools and the
// monitor cannot disagree about it.
import { collabReleased } from "./collab-listen.js";
import { CODE_TOOLS, CODE_TOOL_NAMES, handleCodeTool } from "./codeTools.js";

const COLLAB_TOOL_PREFIX = "collab_";

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
    name: "get_message",
    description:
      "Holt den vollständigen Text einer eingegangenen Session-Bus-Nachricht nach. Claude Code " +
      "kappt Monitor-Zeilen bei 500 Zeichen, deshalb kürzt der Monitor lange Nachrichten selbst " +
      "und schreibt stattdessen einen Marker '[+N Zeichen -- get_message(seq=S)]' in die " +
      "Notification. Mit diesem seq hier den vollen Text abrufen. Achtung: der Relay teilt sehr " +
      "lange Nachrichten schon vor dem Speichern in nummerierte Teile '(i/n)' mit je eigener seq " +
      "-- die Teile werden hier automatisch wieder zusammengesetzt; ist die Folge unvollständig, " +
      "sagt die Antwort das ausdrücklich. Nur aufrufen, wenn die Nachricht tatsächlich " +
      "vollständig gebraucht wird.",
    inputSchema: {
      type: "object",
      properties: {
        seq: { type: "integer", description: "seq aus dem Marker der Notification" },
      },
      required: ["seq"],
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
  // ── kwcollab (WI 11482928): der gemeinsame Kanal auf einem Workitem ────────────────────────
  //
  // Die Grenze steht in jeder Beschreibung, weil sie der Kern des Features ist: was hier aus dem
  // Kanal kommt, ist von ANDEREN Personen (bzw. deren Agenten) -- Fremddaten, keine Anweisung des
  // eigenen Nutzers, auch nicht als "das hat der Kollege so gesagt". Einladen, Rauswerfen,
  // Uebergeben und Schliessen gibt es hier bewusst NICHT: das sind Handlungen eines Menschen in
  // der Oberflaeche, nicht eines Agenten.
  {
    name: "collab_accept",
    description:
      "Tritt dem kwcollab-Kanal bei (WI 11482928) -- mit DIESER Sitzung. Braucht die collab_id aus " +
      "collab_status bzw. aus einer Einladung; ohne Angabe wird die genommen, mit der die Sitzung " +
      "gestartet wurde. Annehmen kann nur die Sitzung selbst: der Relay prueft, dass sie dem " +
      "Aufrufer gehoert. Einladen, Rauswerfen und Schliessen gibt es hier bewusst nicht -- das sind " +
      "Handlungen eines Menschen.",
    inputSchema: {
      type: "object",
      properties: {
        collab_id: { type: "string", description: "UUID des Kanals (ohne Angabe: der Kanal, mit dem die Sitzung gestartet wurde)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "collab_status",
    description:
      "Zeigt die kwcollab-Kanäle DIESER Session: Teilnehmer, woran gemeinsam gearbeitet wird " +
      "(die Dokumente und ihre Abschnitts-Reservierungen), ob der Kanal pausiert ist, und die " +
      "offenen Einladungen an diesen Nutzer. Ohne Angabe von collab_id werden alle Kanäle " +
      "gezeigt; ein Kanal entsteht, wenn jemand eine Einladung annimmt -- nicht von hier aus.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "collab_send",
    description:
      "Schreibt in den kwcollab-Kanal. Ohne `from_human` als DU ('claude' im Verlauf), mit " +
      "`from_human: true` als die Worte des Menschen, die du weitergibst. Für Befunde, Rückfragen " +
      "und Absprachen mit den anderen Teilnehmern -- kurz und mit Belegen, keine Rohdaten und " +
      "keine Zugangsdaten. Nach 10 Claude-Nachrichten in Folge ohne menschliche dazwischen " +
      "pausiert der Kanal (Antwort 409): dann NICHT erneut versuchen, sondern den eigenen Nutzer " +
      "fragen. Gibst du einen Auftrag deines Nutzers wortgleich weiter, setze `from_human` -- sonst " +
      "zaehlt deine Weitergabe als Agenten-Nachricht und treibt den Pausen-Zaehler.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Die Nachricht (kurz; Belege lieber als Anhang)" },
        collab_id: { type: "string", description: "Nur nötig, wenn diese Session in mehreren Kanälen ist" },
        from_human: {
          type: "boolean",
          description:
            "Nur setzen, wenn der Text die Worte deines Nutzers sind (Auftrag, Antwort), nicht " +
            "deine eigene Formulierung. Die Zeile steht dann als Mensch im Verlauf und setzt den " +
            "Pausen-Zaehler zurueck.",
        },
        attachment_id: {
          type: "string",
          description: "Optional: UUID eines vorher hochgeladenen Anhangs (eigener Upload nötig)",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "collab_leases",
    description:
      "Zeigt die aktiven Abschnitts-Reservierungen im kwcollab-Kanal: welcher Abschnitt eines " +
      "gemeinsam bearbeiteten Dokuments gerade von wem gehalten wird und bis wann. Vor dem " +
      "Schreiben in ein gemeinsames Dokument prüfen, damit zwei Claudes nicht denselben " +
      "Abschnitt überschreiben.",
    inputSchema: {
      type: "object",
      properties: {
        collab_id: { type: "string", description: "Nur nötig, wenn diese Session in mehreren Kanälen ist" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "collab_lease",
    description:
      "Reserviert EINEN Abschnitt eines Dokuments im kwcollab-Kanal (z. B. '## Preisblatt') für " +
      "eine begrenzte Zeit. Beratend, nicht erzwingend: hält jemand anderes den Abschnitt, kommt " +
      "eine Antwort mit dem Halter statt einer Reservierung -- dann den Abschnitt nur LESEN und " +
      "Befunde in den Kanal schreiben. Gegen Überschreiben schützt die Versionsprüfung des " +
      "Zielsystems.\n" +
      "WELCHES Dokument, leitest du aus deinem eigenen Zusammenhang ab (`subject_kind` + " +
      "`subject_ref`): die Datei, den MR, den Wiki- oder DMS-Eintrag, an dem du gerade schreibst. " +
      "Der Kanal legt ihn an, wenn er ihn noch nicht kennt. Das ist Betriebsbuchhaltung und geht " +
      "den Menschen nichts an -- frag ihn nicht danach und erzähle ihm nicht davon. `subject_id` " +
      "geht weiter, braucht aber einen Eintrag, den der Kanal schon kennt.\n" +
      "FÜR QUELLCODE RESERVIERST DU NICHTS: eine Datei sperrt niemand, Konflikte löst git. " +
      "Reservierungen sind für Abschnitte von Dokumenten, die von Hand geschrieben werden.",
    inputSchema: {
      type: "object",
      properties: {
        subject_kind: {
          type: "string",
          enum: ["workitem_md", "wiki", "dms", "file", "mr"],
          description: "Art des Dokuments, das du benennst: workitem_md (Text des Workitems), wiki, dms, file (Datei im Repo), mr",
        },
        subject_ref: {
          type: "string",
          description:
            "Das Dokument selbst: bei file der Pfad IM REPO mit Vorwärtsstrichen " +
            "(kwterm/node/src/agent.ts), bei mr die MR-URL, bei wiki/dms die ID. NIE ein Pfad " +
            "deines Rechners -- sonst zeigen zwei Rechner auf zwei Dinge, die sich nie treffen.",
        },
        subject_title: { type: "string", description: "Optional: wie das Dokument im Kanal heißen soll" },
        subject_id: {
          type: "string",
          description: "UUID eines Eintrags, den der Kanal schon kennt (subject_id aus collab_status) -- nur, wenn du ihn nicht selbst benennst",
        },
        section: { type: "string", description: "Der Abschnitt, z. B. '## Preisblatt' oder ein Dateipfad" },
        ttl_sec: { type: "integer", description: "Reservierungsdauer in Sekunden (Standard 1800, max 28800)" },
        reason: { type: "string", description: "Optional: was du dort tust" },
        collab_id: { type: "string", description: "Nur nötig, wenn diese Session in mehreren Kanälen ist" },
      },
      required: ["section"],
      additionalProperties: false,
    },
  },
  {
    name: "collab_release",
    description:
      "Gibt eine Abschnitts-Reservierung wieder frei (eigene -- oder als Maintainer eine hängende " +
      "eines abgestürzten Teilnehmers). Beim Abkoppeln und beim Schließen gibt der Server sie " +
      "ohnehin selbst frei.",
    inputSchema: {
      type: "object",
      properties: {
        lease_id: { type: "string", description: "lease_id aus collab_leases" },
        collab_id: { type: "string", description: "Nur nötig, wenn diese Session in mehreren Kanälen ist" },
      },
      required: ["lease_id"],
      additionalProperties: false,
    },
  },
  {
    name: "collab_get_attachment",
    description:
      "Löst einen Anhang aus dem kwcollab-Kanal in einen echten Content-Block auf (Bild als Bild, " +
      "Text/Diff als Text) -- der Monitor kündigt Anhänge nur an. Nur aufrufen, wenn du den Anhang " +
      "tatsächlich ansehen willst.",
    inputSchema: {
      type: "object",
      properties: {
        attachment_id: { type: "string", description: "UUID aus dem Anhang-Hinweis der Kanal-Zeile" },
        collab_id: { type: "string", description: "Nur nötig, wenn diese Session in mehreren Kanälen ist" },
      },
      required: ["attachment_id"],
      additionalProperties: false,
    },
  },
  // Code exchange (WI 11517979): own file, same `collab_` gate.
  ...CODE_TOOLS,
];

const server = new Server(
  { name: "kwos-session-bus", version: "0.5.0" },
  { capabilities: { tools: {} } }
);

/**
 * Die Werkzeuge, die NUR eine Remote-Control-Sitzung angeboten bekommt (2026-10-19, Befund Luca).
 *
 * WARUM: seit dem Kanal-Gate schaltet der Launcher dieses Plugin in JEDER freigegebenen Sitzung
 * zu -- also auch ohne `--kwremote`. `ask_remote` fragt den Menschen per Push und BLOCKIERT bis zu
 * ~9,5 Minuten. In einer Sitzung am Terminal wartet niemand, und die PWA ist gar nicht offen: die
 * Rueckfrage lief ins Leere, jedes Mal. Ohne diesen Filter stand das Werkzeug dort nur mit seiner
 * Beschreibung da ("fuer Momente, in denen niemand am Terminal sitzt") -- und die laedt genau dazu
 * ein. Ein Name in der Werkzeugliste ist ein Versprechen (dieselbe Regel wie bei den Kanal-
 * Werkzeugen oben).
 */
export const REMOTE_ONLY_TOOLS = new Set(["ask_remote"]);

/**
 * Ist Remote Control in DIESER Sitzung aktiv?
 *
 * Zwei Signale, in dieser Reihenfolge: der ausdrueckliche Schalter `KWOS_REMOTE=1`, den der
 * Launcher fuer JEDEN `--kwremote`-Start exportiert (auch wenn das Approval-Token nicht kam), und
 * als RUECKFALL das Approval-Token selbst -- ein Launcher, der aelter ist als diese Zeile, setzt
 * nur das, und eine echte Remote-Sitzung darf durch das Update nicht ihr Werkzeug verlieren.
 * Ohne beides ist die Sitzung NICHT remote.
 */
export function remoteActive(env = process.env) {
  const flag = String(env.KWOS_REMOTE ?? "").trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "yes") return true;
  return Boolean(String(env.KWOS_APPROVAL_TOKEN ?? "").trim());
}

/**
 * The tools a session is OFFERED -- everything except the channel's own, where the ring has not
 * released it, and except the Remote-Control tools, where this session is not one.
 *
 * A filter and not merely a refusal (2026-10-19, WI 11506447): the tool list is the session's
 * picture of what this plugin can do, and `collab_status`, `collab_send`, `collab_accept`,
 * `collab_leases`, `collab_lease`, `collab_release` and `collab_get_attachment` stood in it
 * wherever the plugin was enabled -- i.e. in every `--kwremote` session of the fleet, for a channel
 * the interfaces hide there. A name in the tool list is a promise, and this one was not kept. Same
 * rule as the monitor entry (s. collab-listen.js's header): what is not released is not announced.
 */
export function visibleTools(env = process.env) {
  let tools = TOOLS;
  if (!collabReleased(env)) tools = tools.filter((t) => !t.name.startsWith(COLLAB_TOOL_PREFIX));
  if (!remoteActive(env)) tools = tools.filter((t) => !REMOTE_ONLY_TOOLS.has(t.name));
  return tools;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: visibleTools() }));

// Reine Dispatch-Logik, getrennt von der stdio/MCP-Verdrahtung (gleiches Prinzip wie
// lib.js/server.js im litellm-Repo) -- so testbar ohne Server/Transport hochzufahren.
// Wirft bei Fehlern normal, statt sie selbst in ein isError-Content-Objekt zu verpacken --
// das macht callTool() unten, damit ein Test hier den ECHTEN Fehler sieht (Message/Typ),
// nicht nur eine bereits zu Text geschrumpfte Fehlermeldung.
export async function handleToolCall(name, args = {}) {
  // The same gate as `visibleTools`, on the DOING side: a session that kept an old tool list (or
  // names the tool from its own memory) must not reach the relay either. The wording is kwterm's
  // own for this state (`Zusammenarbeit ist auf diesem Rechner nicht freigegeben`), so a reader
  // cannot tell which of the two surfaces answered.
  if (name.startsWith(COLLAB_TOOL_PREFIX) && !collabReleased()) {
    throw new Error("Zusammenarbeit ist auf diesem Rechner nicht freigegeben (KWOS_COLLAB_CANARY).");
  }
  // The same rule on the DOING side (Befund Luca 2026-10-19): a session that kept an old tool list
  // -- or names the tool from what it read somewhere -- must not spend 9,5 minutes asking a phone
  // nobody is looking at. The refusal names the way out, so the model can act on it.
  if (REMOTE_ONLY_TOOLS.has(name) && !remoteActive()) {
    throw new Error(name + " gibt es nur in einer Remote-Control-Sitzung (--kwremote) -- dieser Mensch sitzt am Terminal, frag dort.");
  }
  if (CODE_TOOL_NAMES.has(name)) return handleCodeTool(name, args);
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
    case "get_message": {
      const msg = await relay.getMessage(args.seq);
      // Der Bild-Hinweis wird nur genannt, nicht ausgeloest -- den Abruf entscheidet weiterhin
      // get_attachment (kein Autowake, s. get_attachment oben).
      const hint = msg.attachment_id
        ? `\n[Bild angehängt, attachment_id=${msg.attachment_id} -- mit get_attachment abrufbar]`
        : "";
      // Eine unvollstaendige Teilfolge wird ausdruecklich gemeldet. Stillschweigend den
      // vorhandenen Rest zu liefern, waere genau der Fehler, den dieser Fix behebt: der Leser
      // haelt einen Ausschnitt fuer das Ganze.
      const warning = msg.incomplete
        ? `\n[UNVOLLSTÄNDIG: diese Nachricht wurde vom Relay in ${msg.chunks} Teile geteilt; ` +
          [
            msg.missingHead ? "die Kopfteile fehlen (nicht mehr abrufbar)" : null,
            msg.missingSeqs.length ? `es fehlen die Teile mit seq=${msg.missingSeqs.join(", ")}` : null,
          ]
            .filter(Boolean)
            .join("; ") +
          ".]"
        : "";
      return { content: [{ type: "text", text: `${msg.text ?? ""}${hint}${warning}` }] };
    }
    case "get_attachment": {
      const { mimeType, data } = await relay.getAttachment(args.attachment_id);
      return { content: [{ type: "image", data, mimeType }] };
    }
    // ── kwcollab (WI 11482928) ───────────────────────────────────────────────────────────────
    case "collab_accept": {
      // The session id comes from THIS process (the marker), never from the caller: the relay's
      // accept checks that the session belongs to the caller, and this is the only place that
      // knows which session that is.
      const id = args.collab_id || config.collab;
      if (!id) {
        throw new Error("Kein Kanal angegeben -- und diese Sitzung wurde mit keinem gestartet.");
      }
      await collab.acceptCollab(id);
      return { content: [{ type: "text", text: `Kanal ${id} beigetreten.` }] };
    }
    case "collab_status": {
      const joined = await collab.myJoinedCollabs();
      if (joined.length === 0) {
        // Ein leerer Zustand ist eine Aussage, keine leere Antwort: der haeufigste Fall ist "noch
        // nicht beigetreten", und ohne diesen Satz sucht der Agent den Fehler bei sich.
        const invites = await collab.myInvitations();
        return {
          content: [{
            type: "text",
            text: invites.length
              ? `Diese Session ist in keinem Collab. Offene Einladungen (in der Sitzungsliste annehmbar): ` +
                invites.map((c) => `${c.collab_id} (Workitem ${c.workitem}${c.title ? `: ${c.title}` : ""})`).join(", ")
              : "Diese Session ist in keinem Collab -- es gibt auch keine offene Einladung.",
          }],
        };
      }
      const out = [];
      for (const c of joined) {
        const detail = await collab.collabDetail(c.collab_id);
        out.push({
          collab_id: c.collab_id,
          workitem: c.workitem,
          title: c.title ?? null,
          paused: Boolean(c.paused),
          claude_streak: c.claude_streak ?? 0,
          participants: (detail?.members ?? []).map((m) => ({
            subject: m.subject, name: m.display_name ?? null, role: m.role, status: m.status,
          })),
          subjects: detail?.subjects ?? [],
          leases: detail?.leases ?? [],
        });
      }
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    }
    case "collab_send": {
      const c = await collab.resolveCollab(args.collab_id);
      const fromHuman = args.from_human === true;
      const sent = await collab.sendCollabMessage(c.collab_id, args.text, args.attachment_id ?? null, fromHuman);
      return {
        content: [{
          type: "text",
          text: `In Kanal ${c.collab_id} (Workitem ${c.workitem}) als ${fromHuman ? "Mensch" : "Agent"} geschrieben. ` +
            `Claude-Nachrichten in Folge ohne Mensch: ${sent.claude_streak ?? "?"}.`,
        }],
      };
    }
    case "collab_leases": {
      const c = await collab.resolveCollab(args.collab_id);
      const leases = await collab.listLeases(c.collab_id);
      if (leases.length === 0) return { content: [{ type: "text", text: "Kein Abschnitt reserviert." }] };
      return { content: [{ type: "text", text: JSON.stringify(leases, null, 2) }] };
    }
    case "collab_lease": {
      const c = await collab.resolveCollab(args.collab_id);
      // The document is named by the caller (kind + ref) or taken from the channel (id). A KIND
      // without a REF is not a name -- `acquireLease` sends only what is complete, and the relay
      // answers 400 for "you named nothing", which is the right sentence for it.
      const named =
        args.subject_kind && args.subject_ref
          ? { kind: args.subject_kind, ref: args.subject_ref, ...(args.subject_title ? { title: args.subject_title } : {}) }
          : undefined;
      const { lease } = await collab.acquireLease(c.collab_id, {
        subjectId: args.subject_id,
        subject: named,
        section: args.section,
        ttlSec: args.ttl_sec,
        reason: args.reason,
      });
      // A held section comes back as 409 and `call()` already throws with the holder in the text.
      // Anything else without a lease is a shape this client does not know -- say that instead of
      // dying on `lease.section` (review finding 2026-10-16).
      if (!lease?.section) {
        throw new Error("Der Relay hat keine Reservierung zurückgegeben (unerwartete Antwort).");
      }
      return {
        content: [{
          type: "text",
          text: `Abschnitt "${lease.section}" reserviert bis ${lease.expires_at}.`,
        }],
      };
    }
    case "collab_release": {
      const c = await collab.resolveCollab(args.collab_id);
      await collab.releaseLease(c.collab_id, args.lease_id);
      return { content: [{ type: "text", text: "Reservierung freigegeben." }] };
    }
    case "collab_get_attachment": {
      const c = await collab.resolveCollab(args.collab_id);
      const { mimeType, data } = await collab.getCollabAttachment(c.collab_id, args.attachment_id);
      // Bilder als Bild-Block (rohes Base64 sieht ein Sprachmodell nicht als Bild), alles andere
      // als Text -- die Kanal-Anhaenge sind ausdruecklich auch Logs und Patches.
      if (mimeType.startsWith("image/")) return { content: [{ type: "image", data, mimeType }] };
      return {
        content: [{
          type: "text",
          text: `Anhang (${mimeType}), Base64:\n${data}`,
        }],
      };
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

  // The session was STARTED from an invitation (KWOS_COLLAB): join the channel now, after the
  // registration above -- the relay's accept checks that the session belongs to the caller, and
  // that check reads exactly this registry row.
  //
  // Behind the SAME gate as the tools and the receive path (2026-10-19, WI 11506447): an invitation
  // can only come from an interface that shows the channel, so outside the ring this variable is
  // either stale (a hand-set environment, an older launcher) or somebody testing -- and a session
  // that silently joins a channel it was never offered would then receive lines from other people's
  // agents without the prompt fragment that marks them as foreign data.
  //
  // A failure here must not cost the session: the channel is an addition, and the human can join
  // again from an interface. It is reported, not swallowed -- a silent failure would leave somebody
  // waiting in a channel that this session never entered.
  if (config.collab && collabReleased()) {
    try {
      await collab.acceptCollab(config.collab);
      log.info("Collab-Kanal beigetreten.", { collabId: config.collab });
    } catch (err) {
      log.error("Collab-Beitritt fehlgeschlagen.", { collabId: config.collab, error: String(err) });
    }
  }

  const heartbeatTimer = setInterval(() => {
    relay.heartbeat().catch((err) => log.error("Heartbeat fehlgeschlagen.", { error: String(err) }));
  }, config.heartbeatIntervalMs);
  heartbeatTimer.unref();

  // `/clear` and `--resume` hand out a NEW session id inside this process. Everything above stays
  // frozen on the id resolved at start: the registry row, the heartbeat, the `from` of every
  // send_message and the session_id of ask_remote. The SessionStart hook rewrites our marker, so
  // the marker is where the truth moves -- adopt it and re-register under the new id.
  //
  // Unref'd like the heartbeat above, and for the same reason: this process ends with its client.
  // An open stdin is what holds it up while the session lives -- the timer only has to fire.
  // Measured 2026-10-16: with this timer ref'd, the server outlived the closed stdin (the old
  // bundle exited 47 ms after stdin close, this one was still alive 10 s later), and an orphan
  // keeps its heartbeat firing, so the session never ages out of the PWA list.
  const rebindTimer = setInterval(async () => {
    let changed = false;
    try {
      changed = await refreshSessionId();
    } catch (err) {
      log.error("Session-ID konnte nicht neu gelesen werden.", { error: String(err) });
      return;
    }
    if (!changed) return;
    try {
      await relay.register();
      log.info("Nach Session-Wechsel neu registriert.", { sessionId: config.sessionId });
    } catch (err) {
      log.error("Registrierung nach Session-Wechsel fehlgeschlagen.", { error: String(err) });
    }
  }, config.sessionIdCheckMs);
  rebindTimer.unref();

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
