---
name: kraftwerk-colouring
description: Applies official kraftwerk Corporate Identity to HTML documents — brand colors, logo, naming conventions. Triggers when user asks to apply kraftwerk brand colors/branding/CI, create a new kraftwerk-branded HTML document, convert any document (PDF, Markdown, Word, text) to branded HTML, or rebrand an existing HTML file. Also triggers on "kraftwerk Farben", "kraftwerk branding", "kraftwerk styled", "kraftwerk CI", "mach das als schönes HTML", "erstelle ein Dokument".
argument-hint: "[Dateipfad | leer = aktuelle Datei | leer = neues Dokument erstellen]"
user-invocable: true
---

# kraftwerk Corporate Identity — HTML

## Farben — Offizielle Palette (ausschließlich diese verwenden)

Quelle: Brand Identity V1025 (Oktober 2025), offizielle kraftwerk CI/CD-Richtlinie.

| Token | Hex | Rolle | Verwendung |
|---|---|---|---|
| `--kw-lime` | `#93c90e` | Highlight | Primärakzent: CTAs, Highlights, Active States, Key Words |
| `--kw-lime-80` | `#a9d43e` | Highlight Tint | Hover-States, sekundäre Akzente |
| `--kw-lime-60` | `#bedf6e` | Highlight Tint | Code-Highlighting, subtile Akzente |
| `--kw-lime-40` | `#d4e99f` | Highlight Tint | Sehr subtile Lime-Tint-Backgrounds |
| `--kw-olive` | `#58790e` | First Subordinate | Große Dekorationselemente — **NICHT für Text < 18px** |
| `--kw-lime-yellow` | `#76a211` | Second Subordinate | Tertiärakzent, min. 14px |
| `--kw-crimson` | `#D0183D` | Second Highlight | Ablehnung · Fehler · Risiko · Kritisch — **nur border-color/color, nie Background** |
| `--kw-sky` | `#2dafe6` | Second Highlight | Neutrale Info · Empfehlung · Kontext — **nur border-color/color, nie Background** |
| `--kw-black` | `#000000` | Brand | Standard-Background, alle Kontexte |
| `--kw-surface` | `#111111` | Surface | Surface Layer 1 |
| `--kw-surface-2` | `#1a1a1a` | Surface | Surface Layer 2 |
| `--kw-gray-80` | `#333333` | Neutral | Borders, Dividers |
| `--kw-gray-60` | `#666666` | Neutral | Sekundärer Text, Labels |
| `--kw-gray-40` | `#999999` | Neutral | Placeholder, Disabled |
| `--kw-white` | `#ffffff` | Brand | Text auf Dunkel, Logo |

> Tints (80%/60%/40%), WCAG-Werte, Pantone/CMYK, Second-Highlight-Tints → `references/color-palette.md`.

**Primärfarbe-Regel:** `--kw-lime` ist der einzige Text-Akzent. `--kw-lime-80`/`-60`/`-40` nur für Code-Backgrounds, Hover-States und subtile Flächen — NICHT als gleichwertiger Text-Highlight neben `--kw-lime`. Nie zwei verschiedene Grün-Töne als Text-Akzente im selben Dokument. Gleichrangige Komponenten → einheitlicher Lime-Ton. Untergeordnete Elemente dürfen eine Tint-Stufe tiefer sein, nie umgekehrt.

**Second Highlight (Crimson/Sky):** Nur einsetzen wo der semantische Kontext es erfordert — Crimson für Fehler/Ablehnung/Risiko, Sky für neutrale Info/Empfehlung. Nie dekorativ. Nie als Vollflächiger Background.

Jede Farbe außerhalb dieser Liste → NICHT verwenden. Kein generisches `#ef4444`, kein Amber `#f59e0b`, kein `#60a5fa`. Keine Gradienten.

## Naming

**Zwei Regeln — beide gelten gleichzeitig:**

1. **Eigenname:** `kraftwerk` — **immer klein**, auch am Satzanfang und als Subjekt im Fließtext.
   - ✓ „kraftwerk vereinigt fünf Firmen" · „Mit dieser kommuniziert kraftwerk"
   - Einzige Ausnahme: Firmierung im Handelsregister → `Kraftwerk Software Holding GmbH` (Impressum, Firmenpapiere mit Anschrift)

2. **Produktnamen-Prefix und Kontext:** `kraftwerk` — immer kleingeschrieben wenn als Namespace-Prefix oder Produktbezug:
   - ✓ `kraftwerk.Energie` · `kraftwerk.Wasser` · `kraftwerk.GWA` · `kraftwerk ERP` · `kraftwerk-Suite` · `kraftwerk.Joules.Direkt`
   - Schema: `kraftwerk.Produkt` — nach dem Punkt zwingend Großbuchstabe: `kraftwerk.Energie` ✓ · `kraftwerk.energie` ✗

Produktnamen-Beispiele:
```
kraftwerk.Energie  kraftwerk.Wasser   kraftwerk.Wärme    kraftwerk.Operations.Hub
kraftwerk.GWA      kraftwerk.EDM      kraftwerk.ZUGFeRD  kraftwerk.Joules.Direkt
kraftwerk.Ablese.App   kraftwerk.Wasserportal   kraftwerk ERP   kraftwerk-Suite
```

**Kurzform:** `kw.<Produkt>` ist eine verbreitete Abkürzung und muss expandiert werden: `kw.Energie` → `kraftwerk.Energie`.

**Nicht-kraftwerk-Produktnamen** (z.B. WinEV, SAP, msu ERP, Kundenprodukte) → 1:1 beibehalten. Kein `kraftwerk.`-Prefix, kein Lime/Weiß-Split auf diesen Namen.

> Vollständige Produktliste + häufige Schreibfehler → `references/naming-convention.md` (Single Source of Truth für Produktschreibweisen).

**Produktnamen in Headlines:** `kraftwerk.` → weiß `#ffffff`, Produktname → lime `#93c90e`. Font-weight NIE explizit in Inline-Spans setzen — den Titel-Container font-weight erben lassen:

```html
<h1><span style="color:#ffffff">kraftwerk.</span><span style="color:#93c90e">Energie</span></h1>
<!-- Mehrteilig: -->
<h1><span style="color:#ffffff">kraftwerk.</span><span style="color:#93c90e">Joules</span><span style="color:#ffffff">.</span><span style="color:#93c90e">Direkt</span></h1>
<!-- FALSCH — font-weight NIE in Inline-Spans überschreiben: -->
<!-- <span style="color:#ffffff;font-weight:400">...</span> ← kaputtmacht Title-Styling -->
```

`kraftwerk.Produkt` in Headlines folgt **immer** dem weiß/lime-Split — überschreibt die generische Emphasis-Regel.

## Ausgabe-Protokoll — Pflicht für neue HTML-Dokumente

Claude Code limitiert Output pro Response (~32k Tokens). Vollständige HTML-Dokumente können diesen Wert überschreiten.

**`<!--LOGO_SVG-->` Platzhalter ist in jedem Dokument Pflicht** — SVG niemals inline in einem Write-Schritt einbetten.

**Kurze Dokumente** (geschätzter Output unter ~400 Zeilen): Einzelner Write mit `<!--LOGO_SVG-->` Platzhalter + Logo-Edit gemäß §4.

**Längere Dokumente — Pflichtsequenz:**

1. **Write — Skeleton** (~150–200 Zeilen): Vollständiges `<head>` mit CSS aus `references/component-patterns.md`, Strukturcontainer mit Platzhaltern `<!--SECTION_N-->` pro logischem Inhaltsabschnitt. Logo-Platzhalter: `<!--LOGO_SVG-->`. Muss gültiges, vollständiges HTML sein inkl. `</body></html>`.
2. **Edit — Abschnitte füllen**: 1 Edit pro Inhaltsabschnitt, max. ~300 Zeilen pro Edit. `old_string: <!--SECTION_N-->`, `new_string: [HTML-Inhalt ohne Platzhalter]` — Platzhalter vollständig ersetzen, nicht davor einfügen.
3. **Edit — Logo**: gemäß §4.

**Nie** ein zweites Write auf dieselbe Datei — überschreibt alle vorherigen Edits.

---

## Workflow

> Pfade (`references/...`, `assets/...`) relativ zum Skill-Verzeichnis auflösen — nicht relativ zur Input-/Output-Datei.

### 1. Kontext erkennen — Output ist immer HTML

| Input | Vorgehen |
|---|---|
| Kein Input / freier Prompt | Neues HTML-Dokument direkt erstellen |
| Markdown / Text / Zusammenfassung | Inhalt als Basis, als schönes HTML aufbereiten |
| PDF / Word / bestehende Datei | Inhalt lesen, Struktur erhalten, als HTML neu aufbauen |
| Bestehendes HTML — Header/Struktur erkennbar | Color Audit, Farben/Naming anpassen, Struktur 1:1 erhalten |
| Bestehendes HTML — kein Header erkennbar | Color Audit + Farben/Naming + Standard-Header einfügen |
| XLSX / DOCX (Binär) | STOPP — nicht direkt lesbar. User bitten: „Bitte als CSV, Markdown oder PDF exportieren." |

**Header-Erkennung:** Existiert `<header>`, `.hdr`, `<nav>` oder eine Top-Bar-Struktur im File? → Bestehende Struktur erhalten. Fehlt alles davon? → Standard-Header einfügen. Explizite User-Anweisung hat immer Vorrang.

### 2. Dark-First Gate — immer zuerst

- Neues Dokument: `body { background: #000000 }` — immer, kein heller Background
- Bestehendes HTML prüfen: `body` und Haupt-Wrapper auf Background-Farbe
  - Hell (`#fff`, `#f*`, `#e*`) → **Full Dark Transformation**: body → `#000`, alle Surfaces → `#111`/`#1a1a1a`, alle Texte → `#fff`
  - CSS-Variablen in `:root` ≠ Theme ist dark. Das visuelle Erscheinungsbild entscheidet.
- Getintete Dark-Backgrounds vermeiden: `background: #1a1700` sieht amber aus → `background: #000` + `border-color: #D0183D`

### 3. Color Audit (nur bei bestehendem HTML)

Datei einmal lesen, alle Farbvorkommen in einem Durchgang identifizieren und korrigieren:

- **`<style>`-Block:** `:root`-Variablen, alle Selektoren, `rgba()`-Literale
- **Inline-Styles:** `style="..."` auf ALLEN Tags (div, span, section, tr, td, article ...)
- **`<script>`-Blöcke:** `style.backgroundColor`, `style.color`, `innerHTML` mit `#`-Strings

Häufige Fehler:
- `rgba()`-Literale separat updaten — CSS-Variablen updaten sie nicht automatisch
- `--kw-crimson`/`--kw-sky` nie als Badge/Dot/Heading/Keyword — nur in `.kw-alert-*` Boxen
- Multi-Accent-Dateien: volle Tint-Palette nutzen statt alles lime

**Pass 4 — Inline SVG:** `<svg>`-Elemente mit hardcoded `fill`/`stroke`-Attributen (CSS-Variablen greifen in XML-Attributen nicht). Erst alle SVG-Hex-Werte aufzählen, dann einmal konsistent semantisch mappen → `references/color-palette.md` Abschnitt "SVG Farb-Mapping".

### 4. Logo einbetten

**Asset:** `assets/logo/kraftwerk_logo1_white.svg` — weißes Logo: `kraftwerk` + Claim „Energie. Software. Services." darunter. Für alle dunklen Hintergründe.

Logo bereits als vollständiges Inline-SVG im Dokument vorhanden → übernehmen, Injektion überspringen.

**Methode: Inline SVG** — für alle teilbaren/verschickbaren HTML-Dokumente (Teams, SharePoint):
1. Read-Tool: `assets/logo/kraftwerk_logo1_white.svg` vollständig einlesen — kein `limit:`-Parameter.
2. **Sofort** das Edit ausführen — kein anderer Tool-Call zwischen Read und Edit. Context-Drift verursacht Pfad-Truncation.
3. SVG-Inhalt beginnt ab `<svg` (Zeile 2) — XML-Prolog `<?xml version="1.0" encoding="UTF-8"?>` weglassen (ungültig in HTML).
4. `fill="#fff"` am `<svg>`-Tag setzen, Höhe und `flex-shrink: 0` über CSS.
5. **Pflicht-Verifikation:** Grep `<path` in SVG-Quelldatei → Anzahl merken. Grep `<path` im HTML → muss identisch sein. Abweichung → Edit wiederholen.

```css
.hdr-logo { height: 38px; width: auto; display: block; flex-shrink: 0; }
```

Kein `src="..."` (bricht beim Teilen). Kein Base64. Kein Bash.

### 5. Standard-Header

**Badge-Inhalt aus Kontext bestimmen — genau ein Wort:**

`TECHNISCH` · `VERGLEICH` · `ANLEITUNG` · `BERICHT` · `PROPOSAL` · `ANALYSE` · `STRATEGIE` · `PROZESS`

Aus dem Dokumentinhalt ableiten. Kein `INTERN`/`EXTERN` — alle Dokumente sind intern.

**CSS — Badge-Alignment:** `.hdr-title` muss ein Flex-Container sein, damit das Badge vertikal zentriert mit der Titelzeile ausgerichtet ist. `vertical-align: middle` allein reicht nicht.

Lies `references/component-patterns.md` → Abschnitte "Standard-Header CSS" und "Standard-Header HTML" — verwende das exakte CSS und HTML-Template daraus, keine Eigenschaftsnamen oder Werte anpassen.

### 5a. Header Meta — Inhalt

**Regel: Header = Identität, nie Provenance.**
- Header zeigt: *was* ist dieses Dokument + sein inhaltlicher Referenzpunkt
- **Nie im Header:** Autor, Firma, Versions-Datum ("Stand: …") — das gehört in den Footer

**Datum-Unterscheidung:** Ein *Event-Datum* (wann das Meeting stattfand) ist Identität → Header. Ein *Versions-Stempel* ("Stand: …") ist Provenance → Footer.

**Inhalt semantisch aus dem Dokument ableiten** — kein starres Schema. Leitfrage: *Was muss jemand als erstes wissen, wenn er dieses Dokument aufmacht?* Max. 3 Segmente, getrennt durch `·`.

Illustrationen (keine starre Tabelle — als Orientierung):
- Meeting Summary → `[Thema/Projekt] · [Organisator] · [Datum, Dauer]`
- Technische Doku → `[Kurzbeschreibung] · [Ticket-Nr.]`
- Architektur-Dokument → `Architektur und Codebase · ESHDF-7824`
- Statusbericht → `[Sprint/Zeitraum] · [Team/Projekt]`

Fallback wenn nichts eindeutig erkennbar: thematischer Satz aus dem Inhalt + Datum.

### 6. Typografie-Emphasis — Regeln

Key Words in lime, Rest in weiß — selektiv bei signifikanten Überschriften:

```html
<h2><span style="color:#93c90e">KRÄFTE</span> bündeln.</h2>
<h2><span style="color:#93c90e">bisheriges</span> Verfahren</h2>
```

**Wann anwenden:** Sektions-Überschriften, Karten-Titeln, Hero-Headlines — wenn es ein natürliches Sinn-Gefälle gibt (Key-Begriff → Rest).

**NIEMALS:** Innerhalb eines einzigen Worts. Nur Überschriften mit mindestens zwei eigenständigen Wörtern (Leerzeichen oder Bindestrich) dürfen gesplittet werden. Lime greift nur an Wörtern mit sichtbarer Grenze — solide Komposita ohne internen Bindestrich (`Bewertungstabelle`, `Systemübersicht`) bleiben weiß, auch wenn die Überschrift weitere Wörter enthält. Kein Fallback auf ein Füllwort.

✓ `DB Konzept` · `Action Items` · `Offene Punkte` · `Sync-Profile` (Bindestrich = Grenze)
✗ `Teil|nehmer` · `Bewertungs|tabelle` · `Zusammen|fassung`
✗ `Bewertungstabelle` als Lime-Span in `Bewertungstabelle – alle Tickets` → ganze Überschrift weiß

**Häufigkeit:** Selektiv für visuelle Akzente, nicht bei jeder Überschrift. Zu oft wirkt es überladen.

**Welches Wort lime:** Das semantisch wichtigste Wort — Hauptbegriff, Produktname, Aktionswort. Bei Zweifelsfällen: erstes Wort lime, Rest weiß. Innerhalb eines Dokuments konsistent — NICHT pro Überschrift frei wechseln.

**Immer:** `kraftwerk.Produkt` in Headlines folgt immer dem weiß/lime-Split (s. Naming-Abschnitt).

### 7. Standard-Footer

Pflicht in jedem Dokument. **Kein Logo im Footer** — sitzt bereits oben rechts im Header.

Lies `references/component-patterns.md` → Abschnitt "Standard-Footer HTML" — verwende das exakte Template daraus.

**Inhalt:**
- **Links:** `Erstellt von [Name]` — Label `#666`, Name `#999` (etwas heller/schwerer). Kein Autor bekannt → sinnvollen Ersatz ableiten (Abteilung, Ticket, Kontext). Nie leer lassen — ein leerer Span bricht die Grid-Zentrierung.
- **Mitte:** Spezifische Sub-Entität — **nicht** den Gruppen-/Holdingname. `iS Software GmbH` ✓ · `Kraftwerk` ✗. Bold, letter-spacing, `#777`.
- **Rechts:** `Stand: [Datum]` — oder bei technischen Docs mit Ticket: `[Ticket-Nr.] · [Datum]`. Werte in `#999`.

## CSS-Basistemplate

```css
:root {
  --kw-lime:      #93c90e;  --kw-lime-80:  #a9d43e;
  --kw-lime-60:   #bedf6e;  --kw-lime-40:  #d4e99f;
  --kw-black:     #000000;  --kw-surface:  #111111;
  --kw-surface-2: #1a1a1a;  --kw-gray-80:  #333333;
  --kw-gray-60:   #666666;  --kw-gray-40:  #999999;
  --kw-white:     #ffffff;
  /* Second Highlight Colors — nur border-color/color, nie Background */
  --kw-crimson: #D0183D;
  --kw-sky:     #2dafe6;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--kw-black);
  color: var(--kw-white);
  font-family: 'Natom Pro', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, Arial, sans-serif;
  font-size: 15px;
  line-height: 1.65;
}
/* Headlines font-weight: 900. Body: font-weight: 400. NIE font-weight in Inline-Spans überschreiben. */
/* Alle font-family-Deklarationen (auch Serif wie Georgia) → kraftwerk-Fontstack ersetzen. */
/* Typografie-Skala (h2–h4, p, li, strong, .container): siehe references/component-patterns.md → "Typografie-Skala CSS" — exakt übernehmen */
```

## Checklist — vor Abschluss (aktive Prüfung, nicht nur abhaken)

- [ ] **Dark-First:** `body { background: #000000 }` — kein heller Background
- [ ] **Farben:** Kein Hex außerhalb der Palette — kein generisches Blau/Orange/Rot als Akzent
- [ ] **Alert-Colors:** `--kw-crimson`/`--kw-sky` nur wo Semantik passt (Ablehnung/Fehler vs. Info), nur als `border-color`/`color` — nie Background. Aktiv nach `#ef4444`, `#f59e0b`, `#60a5fa` suchen und entfernen
- [ ] **Logo:** vorhanden oben rechts, inline SVG vollständig (Grep `<path` SVG-Datei = Grep `<path` HTML, kein XML-Prolog), `fill="#fff"` am SVG-Tag, Höhe 36–40px
- [ ] **Badge:** ein Wort (Dokumenttyp aus Kontext), vertikal zentriert mit Titelzeile
- [ ] **Naming — aktiv scannen:** Alle Varianten erfassen — case-insensitiv nach `kraftwerk`, `KRAFTWERK`, `kw.` suchen: `KRAFTWERK.ENERGIE` → `kraftwerk.Energie`, `kw.Energie` → `kraftwerk.Energie`. `Kraftwerk Software Holding GmbH` im Impressum bleibt. Großbuchstabe nach Punkt: `kraftwerk.energie` ✗ → `kraftwerk.Energie` ✓. Danach Produktnamen-Split prüfen: jedes `kraftwerk.Produkt` in Headlines — `kraftwerk.` = weiß, `Produkt` = lime.
- [ ] **Emphasis-Split:** Nur bei Überschriften mit mind. 2 Wörtern (Leerzeichen/Bindestrich). Einwortige Überschriften — auch zusammengesetzte — vollständig weiß lassen. Kontrolle: jede `<span>`-Grenze in Headings prüfen, kein Buchstabe unmittelbar vor dem Leerzeichen des Wortwechsels fehlt.
- [ ] **Font-weight in Spans:** Keine `font-weight`-Überschreibungen in Inline-Spans innerhalb von Headings
- [ ] **Inhalt 1:1:** Bei Konvertierungen (Markdown, PDF, Word → HTML) alle Inhalte gegen die Quelle prüfen — keine Klammerzusätze, Tabellenzeilen oder Listeneinträge stillschweigend weglassen

## Referenzen — wann laden

| Datei | Inhalt | Laden wenn |
|---|---|---|
| `references/color-palette.md` | Tints (80%/60%/40%), WCAG-Kontrast, Pantone/CMYK, Second-Highlight-Tints | Barrierefreiheitsprüfung, Tint-Abstufungen oder Print-Werte gefragt |
| `references/visual-identity.md` | Hero-Layouts, Typografie-Patterns, Messe-/Marketingkontext | Marketing-Dokument, Hero-Section oder tiefes Design-Prinzip gefragt |
| `references/component-patterns.md` | Standard-Header CSS/HTML, Standard-Footer HTML, Typografie-Skala CSS, Buttons, Forms, Tables, Cards | Neues Dokument erstellen (immer), Standard-Header/Footer einfügen, UI-Komponente bauen |
| `references/naming-convention.md` | Vollständige Produktliste, häufige Schreibfehler | Produktname unbekannt, Schreibweise unklar oder Vollständigkeitsprüfung |
