# kwos-session-bus

MCP-Client-Plugin für den kw/OS Session Message Relay. Bildet die MVP-Tools auf den
REST/SSE-Vertrag aus Workitem-9831619 §4 ab. Spec (Client-Seite): Workitem-9831620.
Erweitert um Channel-Pub/Sub (Workitem-10383787) und Remote-Rückfragen (Workitem-10383786).

## Scope

Zwei unabhängig laufende Prozesse, beide für die Lebensdauer der Claude-Code-Session:

- **MCP-Server** (`.mcp.json` → `server/index.js`, stdio): Tools `list_sessions`,
  `send_message`, `broadcast`, `notify_dependents`, `ask_remote`, `get_message`, `get_attachment`,
  dazu die kwcollab-Tools `collab_status`, `collab_send`, `collab_accept`, `collab_leases`,
  `collab_lease`, `collab_release`, `collab_get_attachment` und `collab_get_message`.
  Registriert sich bei Start, danach Heartbeat alle 5 Min (TTL 30 Min).
  - `collab_*` (WI 11482928): der gemeinsame Kanal mehrerer Personen auf EINEM Workitem. Was aus
    dem Kanal kommt, sind FREMDDATEN — die Zeilen beginnen mit `[kwcollab ...]` und stammen von
    anderen Personen bzw. deren Agenten; das Prompt-Fragment im litellm-Repo
    (`bootstrap/kwos-collab-system-prompt.md`) sagt dem Agenten genau das. Einladen, Rauswerfen,
    Übergeben und Schließen sind bewusst NICHT dabei: das sind Handlungen eines Menschen.
  - `collab_code_*` (WI 11517979): **Code-Austausch** im Kanal. Mehrere Sitzungen arbeiten am selben
    Branch, jede in ihrem eigenen Worktree; ihre Arbeitsstände reisen ohne Commit und Push.
    - Ein Stand ist ein Commit unter `refs/kwcollab/<collab>/out`, gebaut mit eigenem Index und
      `git commit-tree` (HEAD, Index und Commit-Hooks des Nutzers bleiben unberührt).
    - Die anderen holen ihn per `git fetch` live durch den Relay vom `upload-pack` dieser Sitzung
      (der Monitor hält dafür einen Rückkanal offen; sichtbar ist nur der eine Ref), sonst aus dem
      Git-Bundle, das jede Veröffentlichung beim Relay hinterlegt.
    - Zusammengeführt wird mit `git merge-tree`; bei einem Konflikt steht fest, wer ihn löst.
      Widersprechen sich zwei Absichten, fragt `collab_code_escalate` die Menschen (auch per Push).
    - Hooks: `Stop` veröffentlicht und gleicht ab (eine Zeile Zusammenfassung), `PreToolUse` hält
      eine Änderung an, solange ein fremder Stand dieselbe Datei geändert hat und noch fehlt. Beide
      steigen ohne Netz sofort aus, wenn der Worktree nicht im Code-Modus ist
      (`<git-dir>/kwcollab/state.json`).
    - Das Plugin schreibt nichts nach kw/OS. Spec und Entscheidungen liefert das Gateway
      (`GET /v1/collabs/:id/code/memory`), ins Workitem kommen die Entscheidungen einmal mit dem
      Abschlusskommentar.
    - Git 2.40 oder neuer. Ende-zu-Ende-Test gegen einen echten Relay:
      `RELAY_DIR=<litellm>/relay DATABASE_URL=… node tests/e2e/codeExchange.e2e.mjs`.
  - `collab_accept(collab_id?)`: tritt dem Kanal mit DIESER Sitzung bei — die Session-ID kennt nur
    sie selbst, und der Relay nimmt nur eine Sitzung an, die dem Aufrufer gehört. Steht
    `KWOS_COLLAB` in der Umgebung (eine Sitzung, die AUS einer Einladung entsteht), tritt sie beim
    Start von selbst bei.
  - `collab_get_message(seq, collab_id?)` (WI 11536314): holt den vollständigen Text EINER
    Kanal-Nachricht nach — **nicht** zu verwechseln mit `get_message`, das den *Session*-Verlauf
    liest und Kanal-Nachrichten gar nicht kennt. Nötig, weil der Monitor eine lange Kanal-Nachricht
    in nummerierte Teile `(i/n)` zerlegt (s. unten); jede Zeile trägt die `seq` der Nachricht im
    Kopf, und mit dieser `seq` kommt hier der ganze Text zurück. Nutzt den Relay-Endpunkt
    `GET /v1/collabs/{id}/messages/{seq}` (Mitgliedschaft wie die Kanal-Detailroute; 404 für eine
    unbekannte oder ausgeräumte `seq`). **Diese Route ist der Gegenpart in der `litellm`-Hälfte und
    muss zusammen mit dem Kanal-Zeilen-Format (s. unten) ausgeliefert werden.** Ein Anhang wird nur
    angekündigt, nicht abgerufen (`collab_get_attachment`).
  - `notify_dependents(channel, summary, workitem_ref?)`: benachrichtigt ALLE Sessions (auch
    fremder Nutzer/Teams), die einen Channel abonniert haben — z. B. bei einer geänderten
    Schnittstelle zwischen zwei Services. Jede Session abonniert per Default den Basename ihres
    eigenen Arbeitsverzeichnisses (`KWOS_CHANNELS`, kommagetrennt, für zusätzliche Channels).
  - `ask_remote(question, options?)`: generalisierter Async-Human-in-the-loop über
    PreToolUse-Freigaben hinaus — wartet bis zu ~9,5 Min auf eine Antwort über die
    Remote-Control-PWA, liefert bei Zeitablauf ein klares "keine Antwort" statt zu blockieren.
  - `get_message(seq)` (WI 11075502): holt den vollständigen Text einer eingegangenen Nachricht
    nach. Nötig, weil der Monitor lange Nachrichten kappen MUSS (s. unten) und in der
    Notification nur noch `[+N Zeichen -- get_message(seq=S)]` nennt. Nutzt den bestehenden
    Relay-Endpunkt `GET /v1/sessions/{self}/messages?since=` — kein Relay-Deploy nötig.
    - **Geteilte Nachrichten werden wieder zusammengesetzt.** Der Relay teilt lange Nachrichten
      schon VOR dem Speichern in nummerierte Teile `(i/n)` mit je eigener `seq`
      (`relay/lib.js` `splitLongMessage`, `MESSAGE_SPLIT_MAX_LEN = 900`) — ein 5000-Zeichen-Bericht
      sind dort also sechs Zeilen. `get_message` erkennt die Nummerierung und holt sich bei einem
      Aufruf mit der `seq` eines *mittleren* Teils (der Normalfall — jede gekappte Zeile trägt ihre
      eigene `seq` im Marker) über eine zweite Seite den Kopf dazu. Fehlt ein Teil, sagt die Antwort
      das ausdrücklich (`UNVOLLSTÄNDIG` + die fehlenden `seq`s), statt einen Ausschnitt als das
      Ganze auszugeben.
    - **Näherung, kein Byte-Identismus:** an den Nahtstellen wird ein Leerzeichen eingefügt. Beim
      Wortgrenzen-Schnitt des Relays ist das genau das entfernte Trennzeichen; beim harten Schnitt
      (kein Leerzeichen im Fenster) entsteht dadurch eines zuviel.
  - `get_attachment(attachment_id)` (WI 10460008, Phase 2 zu MR !8 im litellm-Repo): löst eine
    `attachment_id` (steckt im Notification-Hinweis einer Nachricht mit Bild) in einen echten
    Bild-Content-Block auf (`GET /v1/attachments/:id`) — bewusst NICHT als Base64-Text, das
    sieht ein Sprachmodell nicht als Bild. Kein Autowake: die Session entscheidet selbst, ob/
    wann sie ein angekündigtes Bild abruft.
- **EIN Background-Monitor** (`monitors/monitors.json` → `server/monitor.js`): nutzt das
  offizielle Claude-Code-`monitors`-Primitiv statt eines selbstgebauten Companion-Prozesses
  (Option A aus Workitem-9831620 §2.2, jetzt auf offiziellem Fundament — siehe Kommentar
  vom 2026-07-16). Hält die SSE-Verbindung zum Relay offen (Reconnect via Last-Event-ID) und
  gibt pro eingehender Nachricht eine formatierte Zeile (`[from]: text`) auf stdout aus.
  Trägt eine Nachricht eine `attachment_id`, wird das als zusätzlicher Hinweis in derselben
  Zeile angehängt (kein eigener Kanal, kein Autowake).
  **Warum genau einer (WI 11506447, 2026-10-19):** ein Monitor-Eintrag ist ein Versprechen des
  Harness — Claude Code startet ihn bei jedem Sitzungsbeginn (ein fehlendes `when` und `"always"`
  sind dasselbe) und **kündigt ihn mit seiner Beschreibung an**, bevor der Prozess irgendetwas
  sagen kann. Ein eigener Eintrag für den kwcollab-Kanal erreichte damit jede `--kwremote`-Sitzung
  der Flotte (das Plugin ist dort für Remote Control aktiv) mit einer Beschreibung, die den Kanal
  und seine Workitem-Nummer nannte; ein Gate im Prozess kam erst danach. Deshalb komponiert
  `server/monitor.js` beide Empfangspfade, und das Manifest nennt nur
  den Relay. `tests/monitors.test.js` hält das fest.
- **kwcollab-Empfang** (`server/collab-listen.js`, gestartet von `server/monitor.js`):
  derselbe Weg für den gemeinsamen Kanal (WI 11482928). Er fragt alle 15 s beim Relay, in welchen
  Kanälen DIESE Sitzung sitzt, hält je Kanal einen eigenen SSE-Strom und gibt Zeilen der Form
  `[kwcollab <kurz>:<seq> | <Absender> | mensch|claude] <Text>` aus — Absender und Art stehen in der
  Zeile, weil genau das den Unterschied zu `[from]: …` ausmacht (das ist immer der eigene Nutzer);
  `<seq>` ist die Nachrichtennummer im Kanal (WI 11536314) und der Griff, mit dem der Agent den
  vollen Text per `collab_get_message` nachholt.
  **Geteilt, nicht gekappt (WI 11536314):** eine Nachricht, die nicht in EINE Zeile passt, wird in
  nummerierte Teile `(1/3) …`, `(2/3) …`, `(3/3) …` zerlegt — jedes Teil eine eigene Monitor-Zeile,
  in Reihenfolge, jedes mit vollem Kopf (sonst läse das Prompt-Fragment es als Zeile des eigenen
  Nutzers). Das Budget für den Text wird aus dem **tatsächlichen** Kopf DIESER Zeile gerechnet
  (500 Zeichen Harness-Grenze minus Kopf minus Zähler minus Reserve), nie als feste Zahl: der
  Anzeigename kommt vom Relay und ist bis 128 Zeichen lang. Früher stand der Kürzungs-Marker
  *hinter* dem Schnitt — der Harness kappte ein zweites Mal, und der Marker ging mit (Feldbefund:
  die Nachricht sah vollständig aus und war es nicht). Ein einzelnes überlanges Wort wird hart
  geschnitten, mit einem Marker, der **im** Budget liegt.
  **Eigene Nachrichten kommen NICHT zurück** in die Sitzung: der Relay spielt beim Reconnect bis zu
  500 Frames nach, die eigenen sind darunter, und die Session würde sonst ihre eigene Nachricht
  beantworten.
  **Der Empfang läuft in jeder Sitzung** (WI 11535931): seit das Kanal-Gate im Client entfernt
  ist, gibt es keinen Freigabeschalter mehr — `startCollabListener` startet immer und liefert einen
  Handle. Zeilen eines fremden Agenten kommen deshalb überall mit dem Prompt-Fragment an, das sie
  als Fremddaten kennzeichnet.
  **Die Werkzeugliste nennt die `collab_*`-Werkzeuge immer** (WI 11535931): `visibleTools` filtert
  nur noch die Remote-Control-Werkzeuge, und `handleToolCall` weist keinen Kanal-Aufruf mehr ab —
  ein Name in der Liste ist ein Versprechen, und hier wird es gehalten.
  **Zur Marke `when`:** `"on-skill-invoke:<skill>"` startet einen Monitor mitten in der Sitzung,
  aber nur mit dem VOLL qualifizierten Skill-Namen (`kwos-session-bus:<skill>`); mit dem blanken
  Namen passiert still nichts (im Binary nachgelesen und in einer Sitzung gemessen, 2026-10-15).
  Für das Manifest spielt sie keine Rolle mehr — es gibt nur einen Eintrag, und der ist der Relay.

  **Zeilenbudget — die frühere Annahme "jede Zeile ist eine eigene Notification" ist widerlegt
  (WI 11075502, gemessen):** Claude Code kappt jede Monitor-Zeile bei **500 Zeichen** (eine
  500er Zeile kommt vollständig an, eine 501er verliert ein Zeichen und bekommt
  `...(truncated)`); gezählt werden **Zeichen, nicht Bytes** (nachgemessen mit einer Zeile aus
  501 Umlauten = 1002 Bytes: gekappt wird erst bei Zeichen 500). Zeilen, die dicht beieinander
  geschrieben werden, werden zu **einer** Notification gebündelt und dann bei **3000 Zeichen**
  gekappt. Gekappt wird am Zeilenende — also genau der Bild-Hinweis, der den Abruf erst
  ermöglicht. `formatLine()` kappt deshalb selbst auf `MAX_LINE_CHARS` (480, Reserve unter der
  500er-Grenze) und schreibt stattdessen `… [+N Zeichen -- get_message(seq=S)]`; der Bild-Hinweis
  bleibt damit erhalten. Ohne `seq` (Nachricht ohne Relay-seq) bleibt nur `[+N Zeichen]` — dann
  ist der Rest nicht nachholbar.

  **Zeilenabstand gegen die Bündelung:** weil das 3000-Zeichen-Limit **pro Notification** gilt und
  gebündelte Zeilen am Ende gekappt werden, reicht Zeilenkürzung allein nicht — gemessen verliert
  ein Schwall aus 12 Zeilen à 480 Zeichen ohne Abstand die Zeilen A08–A12 **spurlos, samt
  `seq`-Marker, also nicht nachholbar**. `createLineWriter()` schreibt deshalb mit
  `LINE_SPACING_MS` (250 ms, über dem gemessenen Bündelungsfenster von ~200 ms) Abstand zwischen
  aufeinanderfolgenden Zeilen. Eine einzelne Nachricht wird nie verzögert; nur ein Schwall — real
  erreichbar, weil der Relay beim SSE-Reconnect bis zu 500 Backlog-Nachrichten in einer engen
  Schleife liefert — wird auseinandergezogen. End-to-end nachgemessen: 8 Zeilen à 480 Zeichen
  (3840 Zeichen, ohne Abstand also gekappt) kommen als **8 eigene, vollständige** Notifications an.
  **Bekannte Restgrenzen des Zeilenabstands:**
  - **Weckrufe:** der Relay-Autor hat beim Bau der Teilung ausdrücklich darauf gezählt, dass der
    Harness die Teile zu EINER Notification bündelt (`relay/server.js`: „muss der Monitor dann
    nicht verstehen, dass noch Teile nachkommen, sonst weckt er das LLM mehrfach?"). Der Abstand
    hebt genau diese Bündelung auf — gewollt, weil die Bündelung nachweislich bei 3000 Zeichen
    kappt und die Teile dahinter spurlos verschwinden. Folge: eine geteilte Nachricht erzeugt jetzt
    **eine Notification pro Teil** statt einer (potenziell gekappten). Ob N Weckrufe pro Nachricht
    akzeptabel sind, ist eine Produktentscheidung und **nicht** von diesem Plugin allein zu
    beantworten.
  - **Durchsatz:** der Abstand deckelt die Ausgabe auf 4 Zeilen/s. Ein Reconnect-Backlog ist
    begrenzt (Relay `LIMIT 500` ≈ 125 s), aber dauerhafter Verkehr darüber hinaus lässt
    Warteschlange und Zustell-Verzug unbegrenzt wachsen. Es gibt keine Drop-Policy — sie müsste die
    ältesten, noch ungelesenen Zeilen wegwerfen, also genau das Falsche. Beim Session-Ende wird die
    Warteschlange per `flush()` ausgeliefert.
  - **Die Warteschlange ist die einzige Kopie:** der Relay markiert Backlog-Zeilen beim Schreiben
    der SSE-Frames als zugestellt (`relay/server.js` `markDelivered`). Wird der Monitor-Prozess
    vorher beendet, sind sie weg — und es wurde nie ein `seq`-Marker ausgegeben, `get_message`
    kann sie also nicht nachholen.

Explizit **nicht** im MVP: Desktop-Integration (Claude Desktop hat kein `monitors`-Äquivalent,
bleibt bei reiner Notification ohne Autowake, siehe §2.2), Rate-Limiting/Loop-Detection auf
Client-Seite.

Kein Autowake einer inaktiven Session — die Notification macht die Nachricht sichtbar, was
die Session damit macht, entscheidet sie selbst (Reaction Policy §2.3: wie User-Input
behandeln, nicht blind ausführen).

## Konfiguration (Umgebungsvariablen)

| Variable | Pflicht | Zweck |
|---|---|---|
| `KWOS_RELAY_URL` | nein | Override für die Relay-URL (Default: `https://llm.os.kraftwerk.io` — s. unten, warum ein Default und kein Pflichtfeld) |
| `KWOS_XID_ACCESS_TOKEN` | nein | Override für das Bearer-Token (z. B. lokales Testen) |
| `KWOS_XID_TOKEN_HELPER_PATH` | nein | Override für den Pfad zum `xiam-token.sh`/`.ps1`-Helper (Default: `~/.config/kraftwerk/xiam-token.{sh,ps1}`, siehe unten) |
| `CLAUDE_CODE_SESSION_ID` | nein | Session-ID beim Start. **Ist tatsächlich gesetzt** (gemessen 2026-10-14, s. unten), aber ab dem Prozessstart eingefroren — nach `/clear`/`--resume` gilt die Marker-Datei, nicht dieser Wert |
| `KWOS_SESSION_ID_CHECK_MS` | nein | Wie oft ein laufender Prozess seine eigene Marker-Datei neu liest (Default 5000). Bestimmt, wie lange ein `/clear` unbemerkt bleiben darf |
| `KWOS_SESSION_DISPLAY_NAME` | nein | Override für den Anzeigenamen (Default: Basename des Arbeitsverzeichnisses, siehe unten) |
| `KWOS_CHANNELS` | nein | Kommagetrennte ZUSÄTZLICHE Channels (Pub/Sub, WI 10383787) — Default-Channel ist immer der Basename des Arbeitsverzeichnisses, unabhängig davon |
| `KWOS_COLLAB` | nein | Die collab_id, in die diese Sitzung beim Start eintreten soll (WI 11482928). Gesetzt von der Oberfläche, die eine Sitzung AUS einer Einladung startet — die Sitzung ist die einzige, die ihre eigene Session-ID kennt (s. `collab_accept`) |

## Offene Punkte (bewusst nicht stillschweigend geraten)

1. **Token-Beschaffung — gelöst:** die ursprüngliche Annahme einer Cache-Datei
   (`~/.kwos/xiam-token.json`) hatte nie einen Schreiber — geprüft gegen `kraftwerkos` und die
   `xiam-token.sh`/`.ps1`-Helper selbst, keiner legt diese Datei an. `server/auth.js` ruft
   stattdessen denselben Helper auf, den `kwclaude` schon für den `apiKeyHelper`-Login nutzt
   (`~/.config/kraftwerk/xiam-token.sh` bzw. `.ps1`, aus CLI-SETUP.md), mit `XIAM_REFRESH_ONLY=1`
   (Helper-seitig neu, s. LiteLLM-Gateway-Repo) — refresh-only, kein Browser, kein Warten auf
   interaktiven Login. Fehlt der Helper (kein `kwclaude`-Setup auf der Maschine) oder ist kein
   Refresh-Token gecacht, scheitert die Registrierung mit klarer Fehlermeldung statt eines
   stillen/hängenden Zustands.
2. **Claude-Code-Session-ID — korrigiert 2026-10-14, gemessen.** Hier stand, weder der
   stdio-MCP-Server noch ein per `monitors` gestarteter Prozess bekomme
   `CLAUDE_CODE_SESSION_ID` in der Umgebung. **Das ist falsch:** der Wert stand in der Umgebung
   eines shell-gestarteten `node`-Prozesses, neben den `KWOS_*`-Exporten des Launchers. Warum die
   Marker-Datei trotzdem bleibt: der Env-Wert ist **ab dem Prozessstart eingefroren**. Nach
   `/clear` und `--resume` vergibt Claude Code **innerhalb desselben Prozesses** eine neue
   Session-ID — die Relay-Hooks (die sie je Event sehen) registrieren die Sitzung unter der neuen,
   der längst laufende Listener abonniert weiter die alte. Jede vom Handy gesendete Nachricht geht
   dann ins Leere: sie bleibt in `relay.messages` als „eingereiht“ liegen, und nirgends steht ein
   Fehler (Befund Steffen 2026-10-14, „wenn man wirklich mal was will, sendet es nicht zur
   Sitzung“).

   Deshalb ist die Marker-Datei die **aktuelle** Wahrheit und der Env-Wert nur der Startpunkt:
   - Der `SessionStart`-Hook (`hooks/write-session-id.js`) schreibt sie bei **jedem** Start neu,
     auch bei `clear` und `resume`.
   - Der Dateiname ist der **Client** (`KWOS_CLIENT_ID`, vom Launcher exportiert, eine je
     gestartetem `claude`-Prozess, überlebt `/clear` und `--resume`) — **nicht** das Verzeichnis.
     Eine Datei je Projektverzeichnis ist letzter-Schreiber-gewinnt: zwei Sitzungen im selben
     Verzeichnis teilen sie, und die andere Sitzung abonniert dann unter einer fremden ID. Die
     alte `.kwos-session-bus-id` wird weiter geschrieben, für Leser, die älter sind als diese
     Änderung.
   - **WO SIE LIEGEN** (für jeden, der ein Repo pflegt, in dem `kwclaude` läuft): im
     Projektverzeichnis, also im Repo-Root der Sitzung — `.kwos-session-bus/<client-id>` (eine
     Datei je Client) und daneben die alte `.kwos-session-bus-id`. Beide sind Laufzeit-Artefakte
     einer laufenden Sitzung und gehören in die `.gitignore` des Repos; sonst nimmt ein
     `git add -A` sie mit. Sie entstehen in **`--kwremote`-Sitzungen**, nicht in jeder: geschrieben
     werden sie von diesem Plugin, und das ist nur dort zugeschaltet (`bootstrap/kwclaude-gw.sh` —
     ein Monitor in jeder Sitzung löste den „Background work is running"-Prompt aus, WI 10291673).
     `KWOS_CLIENT_ID` exportieren beide Launcher zwar immer, aber der Export allein schreibt nichts.
     Im litellm-Repo steht bisher nur `.kwos-session-bus-id`; die Regel für das Verzeichnis gehört
     dort noch hinein.
   - `server/config.js` löst in dieser Reihenfolge auf: eigene Marker-Datei (kurzes Polling, Hook
     und Prozess starten unabhängig) → eingefrorener Env-Wert → alte Datei je Verzeichnis → lokal
     generierte UUID (mit lautem Log-Warning).
   - `refreshSessionId()` liest die eigene Datei im Betrieb neu (`KWOS_SESSION_ID_CHECK_MS`) und
     bindet bei Änderung neu: der MCP-Server registriert sich neu, der Monitor verwirft seinen
     SSE-Strom und verbindet unter der neuen ID. Unit-getestet in `tests/config.test.js` (echter
     Kindprozess mit echter Datei).
   - **Ein kwcollab-Kanal muss dabei mitwandern:** die Mitgliedszeile im Relay nennt die Sitzung,
     die beigetreten ist, und `myJoinedCollabs()` filtert genau darauf — nach `/clear` wäre der
     Kanal für den Client also weg (jedes Werkzeug verweigert, der Monitor lässt seine Ströme
     fallen). Der Relay verschiebt die Zeile bei einem erneuten `accept` auf die neue ID; der
     Monitor nimmt deshalb die Kanäle, die **diese Sitzung** hielt, nach dem Wechsel neu an. Nur
     die: ein zweites Fenster kann im selben Kanal sein, und ein `accept` von hier zöge ihm die
     Mitgliedschaft weg. Ein Kanal, der gerade erst beigetreten ist und dessen Strom noch nicht
     steht, zählt mit (er war sonst genau in diesem Fenster still verloren).
   - **Nicht abgedeckt:** Nachrichten, die in der Zwischenzeit an die ALTE ID gingen, holt niemand
     nach. Ein Abfluss des alten Backlogs beim Wechsel wäre ein eigener Schritt.
3. **`monitors`-Verfügbarkeit/Trust-Level:** Background-Monitore laufen laut Doku nur in
   interaktiven CLI-Sessions, unsandboxed auf demselben Trust-Level wie Hooks, und werden auf
   Hosts ohne Monitor-Tool-Unterstützung übersprungen (dann bleibt nur `list_sessions`/
   `send_message`/`broadcast` manuell nutzbar, kein Empfang). Nicht verifiziert: exaktes
   Verhalten von zwei unabhängig gestarteten Prozessen (MCP-Server + Monitor), die beide
   `register` aufrufen — als idempotent angenommen (Server-Spec sagt nichts Gegenteiliges).
4. **`monitors` bekommen KEIN settings.json-`env` — gelöst, mit realem Produktionsausfall
   gefunden (2026-08-15):** Claude Codes Doku listet, welche Kindprozesse den `env`-Block aus
   settings.json injiziert bekommen — Bash-/PowerShell-Tool, tmux, Hooks, Statusline,
   stdio-MCP-Server. **`monitors` steht NICHT auf dieser Liste.** Per Prozessbaum bestätigt: der
   Monitor läuft über dieselbe Shell-Snapshot/Bash-Mechanik wie das Bash-Tool (Snapshot der
   Shell VOR jeder Claude-Code-eigenen `env`-Überlagerung), nicht als direkter Kindprozess.
   Folge: `KWOS_RELAY_URL` UND `KWOS_SESSION_DISPLAY_NAME` kamen im Monitor nie an — die
   Registrierung scheiterte fortlaufend still (Fehler nur auf `stderr`, das für `monitors`
   nirgends sichtbar landet: kein Fehler in der PWA, keine Meldung irgendwo, Monitor lief
   trotzdem sichtbar in der Fusszeile). In diesem Deployment gibt es ohnehin nur einen Relay und
   der Anzeigename ist reine Kosmetik — beide jetzt mit robustem, envfreiem Default (feste
   Relay-URL bzw. Basename des Arbeitsverzeichnisses wie serverseitig `deriveDisplayName()` in
   `relay/lib.js`). Env-Override bleibt für Tests/andere Deployments.
5. **Shared-Types:** Server (9831619) und Client sind beide Node — ein geteiltes
   TS-Typen-Paket für den §4-Vertrag wäre der saubere v1-Schritt, existiert noch nicht.

## Setup (nur für lokale Entwicklung)

```
npm install
```

## Build -- PFLICHT vor jedem Commit, der server/index.js oder eine seiner Abhängigkeiten ändert

**Gefunden als realer Produktionsausfall (2026-08-16):** dieses Plugin wird über einen
`git-subdir`-Marketplace verteilt — Claude Code klont/kopiert nur die Dateien, es gibt **keinen**
`npm install`-Schritt beim Endnutzer. `server/index.js` importiert aber `@modelcontextprotocol/sdk`
aus `node_modules`, das in einer echten Fleet-Installation **nie existiert** → der MCP-Server
crashte beim Start mit `ERR_MODULE_NOT_FOUND`, sichtbar als `/mcp` → `✘ failed`, Reconnect ändert
daran nichts. Der `monitors`-Prozess (`server/listen.js`) hat KEINE externe Abhängigkeit und lief
deshalb immer — das verschleierte den Ausfall: die Session zeigte aktiv Notifications, obwohl kein
einziges MCP-Tool (`list_sessions`, `send_message`, `broadcast`, `notify_dependents`, `ask_remote`)
je erreichbar war.

**Fix:** `server/index.js` wird zu einer einzigen, in sich geschlossenen Datei gebündelt
(`server/index.bundle.mjs`, alle Abhängigkeiten inklusive SDK inline) — das ist die Datei, die
`.mcp.json` tatsächlich startet. `server/listen.js` braucht KEIN Bundling (keine externe
Abhängigkeit, s. o.).

```
npm run build
```

**Nach jeder Änderung an `server/index.js` (oder `config.js`/`auth.js`/`relay-client.js`/`log.js`,
die es importiert) `npm run build` ausführen und `server/index.bundle.mjs` mitcommitten** — sonst
läuft der alte Stand in Produktion weiter. Real gegengeprüft: echter MCP-JSON-RPC-Handshake
(`initialize` + `tools/list`) gegen die gebündelte Datei liefert alle fünf Tools korrekt.
