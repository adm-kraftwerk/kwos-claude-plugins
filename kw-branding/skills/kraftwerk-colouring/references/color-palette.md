# kraftwerk Color Palette — Complete Reference

> Source: Official "Brand Design COLOR" document (kraftwerk_brand_colours.png)
> Authority: C-Level Decision | Produktmanagement

---

## Primary Colors

### Black (Brand Color)
| Format | Value |
|---|---|
| Hex | `#000000` |
| RGB | 0 / 0 / 0 |
| CMYK | 60 / 40 / 40 / 100 |
| Pantone | Black C |
| PB Integer | `0` |
| Usage | Backgrounds in ALL contexts (print, digital, product UI) |

### Bright Lime Green (Highlight Color)
| Format | Value |
|---|---|
| Hex | `#93c90e` |
| RGB | 147 / 201 / 14 |
| CMYK | 50 / 0 / 100 / 0 |
| Pantone | 2292 C |
| PB Integer | `969107` |
| Usage | **Primary accent** — CTAs, headlines, labels, active states, key words |

---

## Secondary Colors

### Olive Green (First Subordinate)
| Format | Value |
|---|---|
| Hex | `#58790e` |
| RGB | 88 / 121 / 14 |
| CMYK | 55 / 9 / 100 / 42 |
| Pantone | 7491 C |
| PB Integer | `948568` |
| Usage | Secondary accents, supporting elements |

### Lime-Yellow Green (Second Subordinate)
| Format | Value |
|---|---|
| Hex | `#76a211` |
| RGB | 118 / 162 / 17 |
| CMYK | 53 / 4 / 100 / 16 |
| Pantone | 377 C |
| PB Integer | `1155702` |
| Usage | Tertiary accents |

---

## White
| Hex | `#ffffff` | PB Integer | `16777215` |
|---|---|---|---|
| Usage | Text on dark backgrounds, logo on dark, light backgrounds |

---

## Digital Extension (Web Context Only)

### Dark Navy
| Hex | `#1a1a2e` | Usage | Web/app backgrounds on kraftwerk.io website |
|---|---|---|---|

> Note: The official brand color is `#000000`. Dark navy `#1a1a2e` is the kraftwerk.io website implementation.
> Use `#000000` for product UI and print. Use `#1a1a2e` only for web-marketing contexts if matching the website.

---

## Shade / Tint Variants

All official shades are tints mixed with white. Brand defines: 100%, 80%, 60%, 40%.

**Tint formula:** `New = Old + ((255 - Old) × tintPercent)`
- 80% saturation = 20% white mix (tintPercent = 0.20)
- 60% saturation = 40% white mix
- 40% saturation = 60% white mix

### Lime Green Tints
| Variant | Hex | CSS Token |
|---|---|---|
| 100% | `#93c90e` | `--kw-lime` |
| 80% | `#a9d43e` | `--kw-lime-80` |
| 60% | `#bedf6e` | `--kw-lime-60` |
| 40% | `#d4e99f` | `--kw-lime-40` |

### Olive Green Tints
| Variant | Hex | CSS Token |
|---|---|---|
| 100% | `#58790e` | `--kw-olive` |
| 80% | `#79943e` | `--kw-olive-80` |
| 60% | `#9baf6e` | `--kw-olive-60` |
| 40% | `#bbca9f` | `--kw-olive-40` |

### Lime-Yellow Tints
| Variant | Hex | CSS Token |
|---|---|---|
| 100% | `#76a211` | `--kw-lime-yellow` |
| 80% | `#91b541` | `--kw-lime-yellow-80` |
| 60% | `#adc770` | `--kw-lime-yellow-60` |
| 40% | `#c8daa0` | `--kw-lime-yellow-40` |

### Black / Gray Scale
| Variant | Hex | CSS Token | Usage |
|---|---|---|---|
| 100% | `#000000` | `--kw-black` | Primary background |
| 80% | `#333333` | `--kw-gray-80` | Dark text, subtle bg |
| 60% | `#666666` | `--kw-gray-60` | Secondary text |
| 40% | `#999999` | `--kw-gray-40` | Disabled, placeholder |
| 20% | `#cccccc` | `--kw-gray-20` | Borders, dividers |

---

## Second Highlight Colors

> Quelle: Offizielles Markendokument (cd_brandfarben_mit SecondHighlightColors.png)
> Status: Offizielle Brand-Farben — kein Pantone im Quelldokument angegeben. Tints berechnet (nicht aus Quelldokument).

### Crimson (Second Highlight Color)
| Format | Value |
|---|---|
| Hex | `#D0183D` |
| RGB | 208 / 24 / 61 |
| CMYK | 0 / 88 / 71 / 18 |
| Pantone | nicht im offiziellen Dokument angegeben |
| CSS Token | `--kw-crimson` |
| Usage | Ablehnung · Fehler · Risiko · Kritisch — nur als `border-color`/`color`, nie Background |

#### Crimson Tints (berechnet)
| Variant | Hex | CSS Token |
|---|---|---|
| 100% | `#D0183D` | `--kw-crimson` |
| 80% | `#D94664` | `--kw-crimson-80` |
| 60% | `#E3748B` | `--kw-crimson-60` |
| 40% | `#ECA3B1` | `--kw-crimson-40` |

---

### Sky (Second Highlight Color)
| Format | Value |
|---|---|
| Hex | `#2dafe6` |
| RGB | 45 / 175 / 230 |
| CMYK | 70 / 10 / 0 / 0 |
| Pantone | nicht im offiziellen Dokument angegeben |
| CSS Token | `--kw-sky` |
| Usage | Neutrale Info · Empfehlung · Kontext — nur als `border-color`/`color`, nie Background |

#### Sky Tints (berechnet)
| Variant | Hex | CSS Token |
|---|---|---|
| 100% | `#2dafe6` | `--kw-sky` |
| 80% | `#57BFEB` | `--kw-sky-80` |
| 60% | `#81CFF0` | `--kw-sky-60` |
| 40% | `#ABDFF5` | `--kw-sky-40` |

---

## WCAG Accessibility

| Color Pair | Contrast | Level |
|---|---|---|
| `#93c90e` on `#000000` | ~8.9:1 | ✅ AAA |
| `#93c90e` on `#1a1a2e` | ~7.1:1 | ✅ AAA |
| `#ffffff` on `#000000` | 21:1 | ✅ AAA |
| `#ffffff` on `#1a1a2e` | ~15:1 | ✅ AAA |
| `#93c90e` on `#ffffff` | ~2.4:1 | ❌ FAIL |

**Rule:** Never use lime green as text color on white/light backgrounds.
On light backgrounds: use olive `#58790e` or black `#000000` for text.

---

## Recommended Combinations

| Combination | Use Case |
|---|---|
| `#000000` + `#93c90e` + `#ffffff` | Marketing, banners, events — main branding |
| `#000000` + `#93c90e` | Product UI dark mode, app interfaces |
| `#93c90e` bg + `#ffffff` text | Primary buttons, CTAs |
| `#000000` + `#58790e` | Muted professional, secondary sections |
| `#ffffff` + `#000000` | Clean monochrome, logo placement |

## Not Recommended

- Lime green (`#93c90e`) as text on white/light — fails WCAG
- Multiple green variants side-by-side without black separation
- Olive + Lime-Yellow together without hierarchy

---

## SVG Farb-Mapping (Data Visualization)

Inline SVGs haben hardcoded Hex-Werte — `var()` greift nur in CSS-Kontext (`style=""`), nicht in XML-Attributen (`fill="#hex"`). Direkter Hex-Ersatz ist korrekt.

**Vorgehen:** Erst alle SVG-Hex-Werte aufzählen, dann einmal konsistent mappen.

| Semantik | CI-Farbe | Token |
|---|---|---|
| Positiv / verifiziert | `#93c90e` | `--kw-lime` |
| Fehler / kritisch | `#D0183D` | `--kw-crimson` — bevorzugt `stroke`, nicht `fill` |
| In Arbeit / info / neutral | `#2dafe6` | `--kw-sky` |
| Warnung / Vorsicht | `#76a211` | `--kw-lime-yellow` (kein Amber in CI-Palette) |
| Sekundär / dim | `#58790e` | `--kw-olive` |
| Tertiäre Tint | `#bedf6e` | `--kw-lime-60` |
| Neutral / Labels | `#666666` / `#999999` / `#333333` | Gray-Tokens |
| Dunkel-Hintergrund | `#111111` / `#1a1a1a` | `--kw-surface` / `--kw-surface-2` |

`rgba()`-Literale in SVGs separat mappen — erben keine CSS-Variablen.

**Mehr Kategorien als Akzentfarben:** Geordnete Reihen (Hierarchie, Stufen) → Tint-Abstufung (lime → lime-60 → olive → gray). Rein nominale Reihen mit 6+ → Farbe allein reicht nicht, Label/Form als zweite Encoding-Dimension hinzufügen.
