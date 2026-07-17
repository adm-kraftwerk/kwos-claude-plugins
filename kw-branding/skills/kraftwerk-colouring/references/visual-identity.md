# kraftwerk Visual Identity

Design principles extracted from official brand materials.
Sources: brand color sheet, messe mockup, banners, product UI, website.

---

## Core Philosophy: Dark-First

All kraftwerk materials — marketing, product UI, banners, events — use **dark backgrounds** as the default.

| Context | Background | Text |
|---|---|---|
| Marketing / Banners | `#000000` pure black | White + Lime Green |
| Product / App UI | `#000000` pure black | Lime Green labels, White body |
| Trade Shows / Events | `#000000` walls, lime green 3D objects | White logo |
| Website (kraftwerk.io) | `#1a1a2e` dark navy (web-specific) | White + Lime Green |
| Light sections (web only) | `#f8fafc` | `#1a1a2e` text |

**Key insight:** Even product interfaces (e.g. Joules.DIREKT calculator) use pure black `#000000` — not navy. Dark-first is not just marketing, it's the product brand.

---

## Typography Pattern: Alternating Emphasis

The most consistent and recognizable kraftwerk design pattern:
**Key word in Lime Green → rest of headline in White** (on dark background).

### Pattern
```
EMPHASIZED WORD   rest of headline text.
└── #93c90e       └── #ffffff (on dark)
```

### Documented Real Examples
| Lime Green Part | White Part |
|---|---|
| `IMMER` | `ein paar Schritte VORAUS.` |
| `KRÄFTE` | `bündeln.` |
| `ANWENDER-` | `tagung 2025` |
| `Joules.` | `DIREKT` |
| `FÜNF TECHNOLOGIE-FIRMEN` | `aus dem Bereich DER ENERGIE- und WASSERWIRTSCHAFT` |

### HTML/CSS Implementation
```html
<h1 class="kw-headline">
  <span class="kw-highlight">KRÄFTE</span> bündeln.
</h1>

<style>
.kw-headline {
  color: #ffffff;
  font-weight: 700;
  font-size: 3rem;
  line-height: 1.1;
  background-color: #000000;
}
.kw-highlight {
  color: #93c90e;
}
</style>
```

### Rules
- Key word is typically ALL-CAPS or the product/brand name
- Rest of line is Mixed Case or lowercase
- Never lime green on white background (fails WCAG)
- Font weight: 700 (Bold) minimum for headlines

---

## Logo Placement Rules

- **Lowercase always:** `kraftwerk` — never `Kraftwerk` (except legal/impressum)
- **White logo** on all dark backgrounds (standard use case)
- **Black logo** on white/light backgrounds only
- **Position:** typically top-right in marketing materials, top-left in product UI
- **Claim:** "Energie. Software. Services." always below brand name
- **Never:** distort, rotate, add shadow/glow, recolor
- **Min width:** 120px (with claim), 32px (icon only)
- **Clearspace:** 20px minimum all sides

### Logo Asset Files (in skill)

| File | Usage |
|---|---|
| `assets/logo/kraftwerk_logo1_white.svg` | Weißes Logo: `kraftwerk` + Claim „Energie. Software. Services." — für dunkle Hintergründe |

Source originals (with black variants, print EPS, PNG):
- `D:\Claude Playground\231110_rz_kraftwerk-logo_white_rgb\` — SVG + PNG (without claim)
- `D:\Claude Playground\231110_rz_kraftwerk-logoclaim_white_1920px_digital (1)\` — SVG + PNG (with claim)
- `D:\Claude Playground\231110_rz_kraftwerk-logo_white_4c (1)\` — EPS (print, 4-color)

---

## Color on Dark Background — Usage Guide

| Element | Color | Notes |
|---|---|---|
| Logo | `#ffffff` white | Always white on dark |
| Headline emphasis | `#93c90e` lime | Key words, product names |
| Headline rest | `#ffffff` white | Remaining headline text |
| Body text | `#ffffff` or `rgba(255,255,255,0.8)` | Descriptions, details |
| Primary CTA | `#93c90e` bg + `#ffffff` text | Action buttons |
| Section tag / badge | `rgba(147,201,14,0.2)` bg + `#93c90e` text | Category labels |
| Borders / dividers | `rgba(147,201,14,0.2)` | Subtle separators |
| Input fields | `#1a1a2e` or dark gray bg, `#ffffff` text | Form inputs |
| Labels / field names | `#93c90e` lime | Form field labels |

---

## 3D / Physical Brand Elements

From trade show materials:
- Physical objects (furniture, steles, columns): **Lime Green** `#93c90e`
- Podiums / reception desks: **Black** with lime green text
- Digital displays at events: Black background, lime green text/accents
- Floor: neutral gray (unbranded)

This translates to digital as: structural elements in black, accent objects/containers in lime green.

---

## Product Portfolio Colors (from thumbnail_1452189)

The portfolio diagram uses:
- Top bar (kraftwerk brand header): `#93c90e` lime green background, `#ffffff` white logo/text
- Section boxes: white background, `#000000` black text and borders
- Sub-product logos: their own colors

Translates to: if building a product overview / portfolio layout, use lime green header bar + white content area.
