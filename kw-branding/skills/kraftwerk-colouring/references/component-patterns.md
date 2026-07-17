# kraftwerk Component Patterns

Concrete CSS patterns for UI components, based on official brand materials.

---

## Standard-Templates (Skill-Extrakte)

> Werden vom `kraftwerk-colouring`-Skill exakt übernommen — keine Eigenschaftsnamen oder Werte anpassen.

### Standard-Header CSS

```css
.hdr {
  background: #000;
  border-bottom: 1px solid #333333;
  padding: 18px 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  position: sticky;
  top: 0;
  z-index: 100;
}
.hdr-left  { display: flex; flex-direction: column; gap: 4px; }
.hdr-right { display: flex; align-items: center; flex-shrink: 0; }
.hdr-title {
  display: flex;
  align-items: center;
  font-size: 20px;
  font-weight: 900;
  color: #fff;
  line-height: 1.2;
}
.hdr-title .kw-hl { color: #93c90e; }
.hdr-meta  { font-size: 11px; color: #666666; margin-top: 2px; }
.hdr-badge {
  display: inline-flex;
  align-items: center;
  background: rgba(147,201,14,0.12);
  border: 1px solid rgba(147,201,14,0.35);
  color: #93c90e;
  font-size: 10px; font-weight: 700;
  padding: 3px 8px; border-radius: 4px;
  letter-spacing: .07em; text-transform: uppercase;
  flex-shrink: 0;
  margin-left: 10px;
}
.hdr-logo { height: 38px; width: auto; display: block; flex-shrink: 0; }
```

### Standard-Header HTML

```html
<header class="hdr">
  <div class="hdr-left">
    <div class="hdr-title">
      <span class="kw-hl">Keyword</span> Titel Rest
      <span class="hdr-badge">TECHNISCH</span>
    </div>
    <!-- Bei kraftwerk.Produkt-Namen: Prefix + Name in Wrapper-Span — verhindert flex-gap zwischen den Teil-Spans: -->
    <!-- <div class="hdr-title"><span><span style="color:#fff">kraftwerk.</span><span style="color:#93c90e">Energie</span> – Titel</span><span class="hdr-badge">TECHNISCH</span></div> -->
    <div class="hdr-meta"><!-- Inhalt: s. Abschnitt 5a in SKILL.md --></div>
  </div>
  <div class="hdr-right">
    <!-- Vollständiges Inline SVG Logo hier — alle Pfade aus Asset-Datei -->
  </div>
</header>
```

### Standard-Footer HTML

```html
<footer style="border-top:1px solid #222;padding:20px 40px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;font-size:12px;color:#666;">
  <span>Erstellt von <span style="color:#999;">[Name]</span></span>
  <span style="color:#777;letter-spacing:.04em;font-weight:700;font-size:11px;">[Subfirma]</span>
  <span style="text-align:right;">Stand: <span style="color:#999;">[Datum]</span></span>
</footer>
```

### Typografie-Skala CSS

```css
h2 { font-size: 17px; font-weight: 900; color: #fff; margin: 0 0 16px; padding-bottom: 9px; border-bottom: 1px solid #333; }
h3 { font-size: 14px; font-weight: 700; color: var(--kw-lime); text-transform: uppercase; letter-spacing: .05em; margin: 20px 0 10px; }
h4 { font-size: 14px; font-weight: 700; color: #fff; margin: 16px 0 8px; }
p  { color: #ddd; margin-bottom: 10px; }
li { color: #ddd; margin-bottom: 4px; }
strong { color: var(--kw-lime); font-weight: 700; }
.container { max-width: 1140px; margin: 0 auto; padding: 40px 40px 80px; }
```

---

## Buttons

### Primary Button (Lime)
```css
.kw-btn-primary {
  background-color: #93c90e;
  color: #ffffff;
  padding: 0.75rem 1.5rem;
  border: none;
  border-radius: 8px;
  font-weight: 600;
  font-size: 1rem;
  cursor: pointer;
  transition: background-color 0.2s, transform 0.2s;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}
.kw-btn-primary:hover {
  background-color: #a9d43e; /* lime-80 */
  transform: translateY(-2px);
}
.kw-btn-primary:active  { background-color: #76a211; /* lime-yellow */ }
.kw-btn-primary:disabled { background-color: #666666; cursor: not-allowed; transform: none; }
```

### Secondary Button (Outline)
```css
.kw-btn-secondary {
  background-color: transparent;
  color: #93c90e;
  border: 2px solid #93c90e;
  padding: 0.75rem 1.5rem;
  border-radius: 8px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}
.kw-btn-secondary:hover {
  background-color: rgba(147, 201, 14, 0.1);
}
```

### White Button (on dark sections)
```css
.kw-btn-white {
  background-color: #ffffff;
  color: #93c90e;
  padding: 0.75rem 1.5rem;
  border: none;
  border-radius: 8px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}
.kw-btn-white:hover {
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
  transform: translateY(-2px);
}
```

### Small +/- Buttons (Product UI style, from Kraftwerk2.jpg)
```css
.kw-btn-round {
  background-color: #93c90e;
  color: #ffffff;
  width: 2rem;
  height: 2rem;
  border: none;
  border-radius: 6px;
  font-size: 1.25rem;
  font-weight: 700;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
```

---

## Navigation

```css
.kw-nav {
  background-color: #000000;
  color: #ffffff;
  padding: 1rem 2rem;
  display: flex;
  align-items: center;
  gap: 2rem;
}
.kw-nav a {
  color: #ffffff;
  text-decoration: none;
  font-weight: 500;
  transition: color 0.2s;
}
.kw-nav a:hover,
.kw-nav a.active { color: #93c90e; }

/* Logo area */
.kw-nav .logo { color: #ffffff; }
```

---

## Section Tags / Badges

```css
.kw-tag {
  display: inline-block;
  padding: 0.35rem 0.875rem;
  background: rgba(147, 201, 14, 0.1);
  color: #93c90e;
  border-radius: 20px;
  font-weight: 600;
  font-size: 0.875rem;
}
/* On dark background */
.kw-section-dark .kw-tag {
  background: rgba(147, 201, 14, 0.2);
  color: #93c90e;
}
```

---

## Form Elements (Dark UI, from Kraftwerk2.jpg)

```css
.kw-form-dark {
  background-color: #000000;
  padding: 2rem;
}

.kw-form-label {
  color: #93c90e; /* Lime Green for field labels */
  font-weight: 600;
  font-size: 0.875rem;
  margin-bottom: 0.5rem;
  display: block;
}

.kw-input {
  background-color: #1a1a1a;
  border: 1px solid #333333;
  color: #ffffff;
  padding: 0.625rem 0.875rem;
  border-radius: 6px;
  font-size: 1rem;
  width: 100%;
}
.kw-input:focus {
  outline: none;
  border-color: #93c90e;
  box-shadow: 0 0 0 2px rgba(147, 201, 14, 0.2);
}
```

---

## Data Tables (Dark UI)

```css
.kw-table {
  width: 100%;
  border-collapse: collapse;
  color: #ffffff;
  background-color: #000000;
}
.kw-table th {
  color: #93c90e;
  font-weight: 600;
  text-align: left;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid #333333;
  font-size: 0.875rem;
}
.kw-table td {
  padding: 0.625rem 1rem;
  border-bottom: 1px solid #1a1a1a;
  font-size: 0.875rem;
}
.kw-table tr:hover td {
  background-color: rgba(147, 201, 14, 0.05);
}
```

---

## Alert / Notification States

```css
/* Success → kraftwerk lime */
.kw-alert-success {
  background: rgba(147, 201, 14, 0.15);
  border-left: 4px solid #93c90e;
  color: #58790e; /* olive for readable text on light bg */
  padding: 1rem;
  border-radius: 4px;
}
/* On dark background */
.kw-section-dark .kw-alert-success {
  color: #93c90e;
}

/* Offizielle Alert-Farben — nur in .kw-alert-* Komponenten */
.kw-alert-error   { background: rgba(208,24,61,0.1);  border-left: 4px solid #D0183D; color: #D0183D; padding: 1rem; border-radius: 4px; }
.kw-alert-warning { background: rgba(208,24,61,0.1);  border-left: 4px solid #D0183D; color: #D0183D; padding: 1rem; border-radius: 4px; }
.kw-alert-info    { background: rgba(45,175,230,0.1); border-left: 4px solid #2dafe6; color: #2dafe6; padding: 1rem; border-radius: 4px; }
```

---

## Hero Section (Marketing / Dark Style)

Based on banners (AWT25, IMMER VORAUS, KRÄFTE bündeln):

```html
<section class="kw-hero-dark">
  <div class="kw-hero-content">
    <span class="kw-tag">Energie. Software. Services.</span>
    <h1 class="kw-hero-title">
      <span class="kw-highlight">KRÄFTE</span> bündeln.
    </h1>
    <p class="kw-hero-subtitle">Erleben Sie das neue Universum von Energie. Software. Services.</p>
    <div class="kw-hero-cta">
      <a href="#" class="kw-btn-primary">Mehr erfahren</a>
      <a href="#" class="kw-btn-white">Demo ansehen</a>
    </div>
  </div>
</section>
```

```css
.kw-hero-dark {
  background-color: #000000;
  color: #ffffff;
  padding: 6rem 2rem;
  min-height: 400px;
  position: relative;
  /* Optional: add noise texture overlay */
}
.kw-hero-title {
  font-size: clamp(2.5rem, 6vw, 5rem);
  font-weight: 700;
  line-height: 1.05;
  color: #ffffff;
  margin-bottom: 1.5rem;
}
.kw-highlight { color: #93c90e; }

.kw-hero-subtitle {
  font-size: 1.125rem;
  color: rgba(255, 255, 255, 0.75);
  max-width: 560px;
  line-height: 1.7;
  margin-bottom: 2rem;
}
.kw-hero-cta { display: flex; gap: 1rem; flex-wrap: wrap; }
```

---

## Cards

### Dark Card (Product style)
```css
.kw-card-dark {
  background-color: #1a1a1a;
  border: 1px solid rgba(147, 201, 14, 0.15);
  border-radius: 12px;
  padding: 1.5rem;
  transition: border-color 0.2s, transform 0.2s;
}
.kw-card-dark:hover {
  border-color: #93c90e;
  transform: translateY(-2px);
}
.kw-card-dark .card-icon { color: #93c90e; }
.kw-card-dark .card-title {
  color: #ffffff;
  font-weight: 700;
  margin-bottom: 0.5rem;
}
.kw-card-dark .card-text { color: rgba(255, 255, 255, 0.7); }
```

### Light Card (Website style)
```css
.kw-card-light {
  background-color: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 1.5rem;
  transition: box-shadow 0.2s, transform 0.2s;
}
.kw-card-light:hover {
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.1);
  transform: translateY(-2px);
}
.kw-card-light .card-icon { color: #93c90e; }
.kw-card-light .card-title { color: #1a1a2e; font-weight: 700; }
```

---

## Portfolio Header Bar (from thumbnail_1452189)

The product portfolio diagram shows a lime green header bar:

```css
.kw-portfolio-header {
  background-color: #93c90e;
  color: #ffffff;
  padding: 1.25rem 2rem;
  display: flex;
  align-items: center;
  gap: 1rem;
}
.kw-portfolio-header .logo { filter: brightness(0) invert(1); } /* white logo */
.kw-portfolio-body {
  background-color: #ffffff;
  border: 2px solid #000000;
  padding: 1.5rem;
}
```