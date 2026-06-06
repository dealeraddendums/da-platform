# Feature — graphical printer nudge (arrow pad + live preview)

> For Claude Code. Owner: Allan. Created 2026-06-02.
> Make the Printer Nudge Margins control graphical so users can SEE what raising
> or lowering each margin does. Allan picked **arrow pad + live preview**: keep
> the exact px values, adjust via per-edge arrow steppers, and a page diagram
> updates live. **UI-only** — the data model (`nudge_left/right/top/bottom`) and
> the save path are unchanged.

## Where
`components/SettingsForm.tsx`, the "Printer Nudge Margins" card (~lines 650–678).
Today it's a `grid grid-cols-2` of four `<input type="number">` over
`["left","right","top","bottom"]`, each bound to `settings[`nudge_${side}`]` with
`onChange = parseInt || 0`, saved by the existing `handleSave` ("Save Settings").
Replace the four-input grid with the preview + arrows layout below; keep the
card, the title, and the helper line ("Fine-tune print alignment per printer
(pixels). Set once, applies to all prints.").

## What to build
One row, three parts:

1. **Live sheet preview (center).** A scaled portrait sheet (≈180×233, 8.5×11
   ratio; white fill, 1px `#e0e0e0` border). Inside it, a "print area" rectangle
   inset from the edges and offset by the four nudge values. As any value
   changes, the inner rectangle shifts **in the same direction the real print
   shifts** — confirm the sign convention against how `nudge_*` is applied in the
   print pipeline (print CSS / da-pdf-service) so the preview tells the truth,
   not the opposite. Apply a visual scale factor (e.g. 1px ≈ 1.5–2 preview px)
   and clamp the *visual* offset so the box stays inside the sheet — **never
   clamp the stored value.** Label the inner box "print area" (small, muted).

2. **Arrow steppers, one per edge**, positioned so each control sits on the edge
   it affects:
   - Top edge → ▲ / ▼ pair above the sheet (− / + `nudge_top`).
   - Bottom edge → ▲ / ▼ below.
   - Left edge → ◀ / ▶ to the left.
   - Right edge → ◀ / ▶ to the right.
   Each tap = ±1px on that one margin. Style per design system (height ≈28, square,
   blue `#1976d2` or neutral; readable). `aria-label` each ("Increase top margin",
   etc.). Negative values allowed (no min) — matches today. *Nice-to-have:*
   press-and-hold to repeat.

3. **Numeric readouts (editable).** Keep a small `<input type="number">` per side
   showing the current px value so users can still type an exact number — same
   binding / onChange as today. Place each by its edge/stepper, or as a compact
   2×2 legend.

A small **"Reset to 0"** text button that zeroes all four is a welcome extra.

## Keep unchanged
- `settings.nudge_left/right/top/bottom` and `handleSave` — the preview + arrows
  just read/write those same four numbers via `setSettings`. No API, no migration.
- The "Save Settings" button still persists.

## Verify
- Tap each arrow → the matching value changes 1px AND the preview box moves the
  correct direction (do one real test print to confirm the sign).
- Type a value → preview updates live; Save → reload → values persist.
- Negative values work and render (clamped visually, stored as-is).
- Read-only roles still don't see the section (it's already inside `!isReadOnly`).
- Stop for review before deploy.
