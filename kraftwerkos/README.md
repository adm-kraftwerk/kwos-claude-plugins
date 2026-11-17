# kraftwerkos

Das Claude-Code-Plugin der S&P Solutions / kraftwerk: es verbindet eine Sitzung mit **kw/OS** —
Workitem-Buchung, Werkzeuge, Bots, Postfach und Kalender — und hält die Sitzung mit ihrem Workitem
zusammen.

## Was drin ist

- **MCP `kraftwerk-os`** (`https://os.kraftwerk.io/mcp`, Kopf über `scripts/mcp-headers.mjs`): der
  volle kw/OS-Werkzeugkasten — Workitems, Wiki, Boards, Repositories/CI, Ablage, Tickets, DealDesk,
  Billing, Organisation. Der Helfer holt den Token der angemeldeten Person; es gibt keinen eigenen
  Schlüssel im Repo.
- **MCP `kwos-bots`** (`scripts/bots-mcp.mjs`): die eigenen und freigegebenen Bots sehen
  (`bots_list`), einen Auftrag starten (`bot_trigger`), den Zustand lesen (`bot_jobs`, `bot_job` mit
  Ausgabe) und einen Lauf anhalten (`bot_cancel`).
- **MCP `kwos-session-workitem`** (`scripts/session-workitem.mjs`): welches Workitem diese Sitzung
  trägt, und der Wechsel auf ein anderes.
- **MCP `ms365`** und **`bc365`** (HTTP mit OAuth): Postfach, Kalender, Dateien und Teams bzw.
  Business Central.
- **Hook `SessionStart`** (`scripts/session-start.sh`): hängt die Workitem-Anweisung zwischen die
  `<!-- kraftwerkOS -->`-Marker in `~/.claude/CLAUDE.md` und hält sie über einen Sentinel aktuell.
  Das ist die wirksame Quelle — ein `CLAUDE.md` im Plugin-Ordner wird von Claude Code **nicht**
  geladen (siehe die Datei `CLAUDE.md` hier).
- **Skill `knowledge-memory`**: Wissen aus einer Arbeitssitzung in kraftwerk.knowledge oder ins
  kw/OS-Wiki schreiben, statt es im Transkript zu lassen.

## Einrichtung

Ein Schritt:

```
/plugin install kraftwerkos --marketplace adm-kraftwerk/kwos-claude-plugins
```

Danach einmal anmelden: die HTTP-MCPs öffnen ihren OAuth-Flow
beim ersten Aufruf, `kraftwerk-os` holt seinen Token über den Kopf-Helfer. Für die Workitem-Buchung
genügt der Start über `kwclaude` — der Client schickt das Workitem im Kopf mit.

## Warum es hier kein `CLAUDE.md` gibt

Ein `CLAUDE.md` im Plugin-Ordner wird von Claude Code **nicht** als Projekt-Kontext geladen
(Plugins-Reference: „A `CLAUDE.md` file at the plugin root is not loaded as project context"). Diese
Datei stand hier trotzdem lange — als Schild, weil ihr bloßes Vorhandensein die Annahme erzeugt hat,
sie sei die Quelle der Workitem-Anweisung, und daraufhin beinahe die einzige funktionierende
Auslieferung entfernt worden wäre. Die wirksame Quelle ist `scripts/session-start.sh`; die Doku dazu
steht oben und im Skript selbst.

## Tests

`node --test kraftwerkos/tests/*.test.mjs` (die MCP-Client-Teile; `session-workitem` und `bots-mcp`).
Die Hook- und Server-Teile werden über `claude plugin validate kraftwerkos` geprüft, das im
Pre-Commit-Hook des Repos läuft.

## Lizenz

MIT, wie das Schwester-Plugin `kw-branding`.
