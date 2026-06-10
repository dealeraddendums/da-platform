# Header bar widget — add White + contrast-aware text

> For Claude Code. Owner: Allan. Created 2026-06-10. Small Builder change; no migration.

## Ask
Add **white** as a color option for the Header bar widget's COLOR palette.

## Two parts (white can't just be added — it'd render invisible without #2)
1. **Palette swatch** — add `#ffffff` to the Header bar color swatches in the widget config panel
   (`components/builder/BuilderPage.tsx`, the `w.type === 'headerbar'` block ~line 2107). Render the
   white swatch with a **visible border** (e.g. `1px solid #ccc`) so it's distinguishable from the
   white panel, and so its selected-state outline still reads.
2. **Contrast-aware text** — the header bar render hardcodes white text
   (`components/builder/widgetRenderer.ts:165`: `…background:${d.color}…color:#fff…`). On a white bar
   that's **white-on-white = invisible**. Make the text color adapt to the bar color: a small
   luminance helper — light background → dark text (`#1a1916`), dark background → white. Apply it on
   that one render line:
   ```ts
   color:${readableText(d.color || '#1a1916')}
   ```
   where `readableText(hex)` parses the hex (handle **3- and 6-digit**), computes luminance
   (`0.299r+0.587g+0.114b`), and returns dark text above ~0.6 else `#fff`. This is general (works for
   white now + any future color) rather than a one-off white→black special-case.

**`renderW` is shared by the Builder canvas preview (BuilderPage.tsx:1496) and the PDF** — so this
single change makes a white bar read correctly in **both** the editor and the printed addendum.

## Verify
- White appears in the Header bar palette (visible border), selectable, selected-state shows.
- A **white** header bar renders **dark, readable text** in the Builder canvas AND the printed
  addendum/infosheet.
- The existing dark colors (navy/blue/red/green/purple/orange/black) still render **white** text —
  unchanged.
- STOP for review.
