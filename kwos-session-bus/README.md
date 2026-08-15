# kwos-session-bus

MCP-Client-Plugin für den kw/OS Session Message Relay. Bildet die drei MVP-Tools auf den
REST/SSE-Vertrag aus Workitem-9831619 §4 ab. Spec (Client-Seite): Workitem-9831620.

## Scope (MVP)

Zwei unabhängig laufende Prozesse, beide für die Lebensdauer der Claude-Code-Session:

- **MCP-Server** (`.mcp.json` → `server/index.js`, stdio): Tools `list_sessions`,
  `send_message`, `broadcast`. Registriert sich bei Start, danach Heartbeat alle 5 Min
  (TTL 30 Min).
- **Background-Monitor** (`monitors/monitors.json` → `server/listen.js`): nutzt das
  offizielle Claude-Code-`monitors`-Primitiv statt eines selbstgebauten Companion-Prozesses
  (Option A aus Workitem-9831620 §2.2, jetzt auf offiziellem Fundament — siehe Kommentar
  vom 2026-07-16). Hält die SSE-Verbindung zum Relay offen (Reconnect via Last-Event-ID) und
  gibt pro eingehender Nachricht eine formatierte Zeile (`[from]: text`) auf stdout aus —
  jede Zeile liefert Claude Code automatisch als Notification an die Session.

Explizit **nicht** im MVP: Desktop-Integration (Claude Desktop hat kein `monitors`-Äquivalent,
bleibt bei reiner Notification ohne Autowake, siehe §2.2), Rate-Limiting/Loop-Detection auf
Client-Seite.

Kein Autowake einer inaktiven Session — die Notification macht die Nachricht sichtbar, was
die Session damit macht, entscheidet sie selbst (Reaction Policy §2.3: wie User-Input
behandeln, nicht blind ausführen).

## Konfiguration (Umgebungsvariablen)

| Variable | Pflicht | Zweck |
|---|---|---|
| `KWOS_RELAY_URL` | ja | Basis-URL des Session Relay Service (kein Hardcoding, s. Server-Spec) |
| `KWOS_XID_ACCESS_TOKEN` | nein | Override für das Bearer-Token (z. B. lokales Testen) |
| `KWOS_XID_TOKEN_HELPER_PATH` | nein | Override für den Pfad zum `xiam-token.sh`/`.ps1`-Helper (Default: `~/.config/kraftwerk/xiam-token.{sh,ps1}`, siehe unten) |
| `CLAUDE_CODE_SESSION_ID` | nein | Override für die Session-ID; normalerweise per SessionStart-Hook aus Marker-Datei gelöst (siehe unten) |
| `KWOS_SESSION_DISPLAY_NAME` | nein | Anzeigename bei der Registrierung |

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
2. **Claude-Code-Session-ID — gelöst:** weder der stdio-MCP-Server noch ein per `monitors`
   gestarteter Prozess bekommt `CLAUDE_CODE_SESSION_ID` in der Umgebung. Ein `SessionStart`-Hook
   (`hooks/write-session-id.js`) schreibt die echte `session_id` in eine Marker-Datei
   `.kwos-session-bus-id` im Projektverzeichnis; `server/config.js` sucht sie beim Start
   aufwärts durchs Verzeichnis, mit kurzem Polling (Hook und Prozess starten unabhängig
   voneinander). `CLAUDE_CODE_SESSION_ID` aus der Umgebung bleibt als Override erhalten,
   lokal generierte UUID nur noch als letzter Fallback (mit lautem Log-Warning).
3. **`monitors`-Verfügbarkeit/Trust-Level:** Background-Monitore laufen laut Doku nur in
   interaktiven CLI-Sessions, unsandboxed auf demselben Trust-Level wie Hooks, und werden auf
   Hosts ohne Monitor-Tool-Unterstützung übersprungen (dann bleibt nur `list_sessions`/
   `send_message`/`broadcast` manuell nutzbar, kein Empfang). Nicht verifiziert: exaktes
   Verhalten von zwei unabhängig gestarteten Prozessen (MCP-Server + Monitor), die beide
   `register` aufrufen — als idempotent angenommen (Server-Spec sagt nichts Gegenteiliges).
4. **Shared-Types:** Server (9831619) und Client sind beide Node — ein geteiltes
   TS-Typen-Paket für den §4-Vertrag wäre der saubere v1-Schritt, existiert noch nicht.

## Setup

```
npm install
```

`.mcp.json` startet den Server über `node ${CLAUDE_PLUGIN_ROOT}/server/index.js`.
