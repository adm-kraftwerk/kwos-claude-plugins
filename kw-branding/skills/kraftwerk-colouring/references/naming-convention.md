# kraftwerk Naming Convention — Offizielle Schreibweise

> Quelle: C-Level-Festlegung, Produktmanagement kraftwerk Software Holding GmbH
> Bestätigt durch: kraftwerk product naming guide (Stefan Lallecke, Leitung Marketing)
> Gültigkeit: sofort, überall

---

## Grundregel: `kraftwerk` immer klein

Der Eigenname **kraftwerk** wird grundsätzlich **immer und überall kleingeschrieben** — auch am Satzanfang.

**Ausnahme:** Firmierung im Handelsregister → `Kraftwerk Software Holding GmbH` (nur in Impressum und auf Firmenpapieren mit Anschrift)

---

## Produkt- und Modulnamen

**Schema:** `kraftwerk.ProduktName`

- `kraftwerk.` → **immer klein**
- Produktname nach dem Punkt → **Großbuchstabe am Anfang**
- Eigennamen/Marktbegriffe → übliche Schreibweise beibehalten

### Offizielle Produktnamen (Beispiele)

| Produkt | Schreibweise |
|---|---|
| Energie-Produkt | `kraftwerk.Energie` |
| Wasser-Produkt | `kraftwerk.Wasser` |
| Wärme-Produkt | `kraftwerk.Wärme` |
| App | `kraftwerk.Ablese.App` |
| Joules Direkt | `kraftwerk.Joules.Direkt` |
| Operations Hub | `kraftwerk.Operations.Hub` |
| Joules Go | `kraftwerk.Joules.Go.` |
| GWA | `kraftwerk.GWA` |
| EDM | `kraftwerk.EDM` |
| ZUGFeRD | `kraftwerk.ZUGFeRD` |
| Wasserportal | `kraftwerk.Wasserportal` |
| ERP | `kraftwerk ERP` |
| Suite | `kraftwerk-Suite` |

**Marktbegriffe** (übliche Schreibweise beibehalten, kein Punkt-Schema):
`GWA`, `EDM`, `ERP`, `ZUGFeRD`, `MDE` — werden nie zu `kraftwerk.GWA` etc. umgeschrieben, sondern bleiben als eigenständige Abkürzungen.

---

## Headline-Emphasis-Regel für Produktnamen

Bei der kraftwerk-Branding-Färbung von Headlines mit Produktnamen gilt:

```
kraftwerk.  →  weiß  (#ffffff) — der Firmenname bleibt neutral
Energie     →  lime  (#93c90e) — der Produktname wird akzentuiert
```

**HTML-Pattern:**
```html
<h1><span style="color:#ffffff">kraftwerk.</span><span style="color:#93c90e">Energie</span></h1>
```

Bei mehrteiligen Produktnamen (z.B. `kraftwerk.Joules.Direkt`):
```html
<span style="color:#ffffff">kraftwerk.</span><span style="color:#93c90e">Joules</span><span style="color:#ffffff">.</span><span style="color:#93c90e">Direkt</span>
```

**Begründung:** `kraftwerk.` ist der konstante Firmenprefix — visuell neutral halten. Der variable Produktname trägt die Identität → lime-Akzent dort platzieren.

---

## Häufige Fehler (vermeiden)

| Falsch | Richtig |
|---|---|
| `Kraftwerk.Energie` | `kraftwerk.Energie` |
| `kraftwerk.energie` | `kraftwerk.Energie` |
| `Kraftwerk Software` (in Content) | `kraftwerk Software` |
| `KRAFTWERK` (außer in Logos/Screaming Caps Design) | `kraftwerk` |
