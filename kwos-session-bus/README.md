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
| `KWOS_XID_TOKEN_CACHE_PATH` | nein | Override für den Token-Cache-Pfad (Default: `~/.kwos/xiam-token.json`) |
| `CLAUDE_CODE_SESSION_ID` | nein | Session-ID für Relay-Attribution; ohne diese wird eine lokale UUID generiert (siehe unten) |
| `KWOS_SESSION_DISPLAY_NAME` | nein | Anzeigename bei der Registrierung |

## Offene Punkte (bewusst nicht stillschweigend geraten)

1. **Token-Cache-Pfad/-Format:** "xiam-token-helper-cache" ist in keiner der beiden Specs
   konkret benannt. Angenommen wird `~/.kwos/xiam-token.json` mit Feld `access_token` bzw.
   `accessToken` — konsistent mit dem bereits etablierten `~/.kwos`-Verzeichnis aus dem
   `kraftwerkos`-Plugin. Gegenprüfen gegen das tatsächliche `xiam-token.ps1`-Skript
   (erwähnt in Antwort zu Workitem-9831620), sobald verfügbar.
2. **Claude-Code-Session-ID:** Kein bekannter Mechanismus, wie ein per stdio gestarteter
   MCP-Server *oder* ein per `monitors` gestarteter Prozess an `x-claude-code-session-id`
   herankommt (gilt für beide Prozesse gleichermaßen). Aktuell: `CLAUDE_CODE_SESSION_ID`
   aus der Umgebung, sonst lokal generierte UUID (mit lautem Log-Warning) — dadurch
   passt die Relay-/Gateway-/OTLP-Attribution nicht zusammen, bis das geklärt ist. Diskutiert:
   ggf. löst der Gateway/Relay das serverseitig sauberer (Session-ID beim Node-Start
   injizieren), statt dass der Client rät — siehe Kommentar an Workitem-9831619.
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
