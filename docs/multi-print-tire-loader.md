# Feature — branded tire loader for the multi-print overlay

> For Claude Code. Owner: Allan. Created 2026-06-02.
> Swap the hand-built car-assembly animation in the multi-print loading overlay
> for Allan's animated tire SVG. Asset is **already placed** at
> `da-platform/public/datire_loader.svg` — `git add` it with the change.

## Where
`components/PdfBuildingOverlay.tsx` — the full-screen overlay shown during bulk
PDF builds (`visible={bulkPrinting}` in both `ManualVehicleInventory.tsx` and
`VehicleInventory.tsx`). It currently renders an inline `<svg>` car animation
(~lines 18–140) on a navy `#2a2b3c` background with two text lines below.

## Change
- Replace the inline car `<svg>…</svg>` block (~18–140) with:
  ```tsx
  <img src="/datire_loader.svg" alt="" width={200} height={200} style={{ display: "block" }} />
  ```
  (≈180–220px square; tweak to taste.) The SVG self-animates — it carries an
  internal SMIL `<animateTransform>` rotate (3s, infinite) that runs when the
  file is loaded as an `<img>`, so **no JS or inlining is needed.** Do NOT paste
  the 3,100-line SVG into the component; reference it by URL.
- Keep the navy `#2a2b3c` overlay container, its `zIndex`, and BOTH text lines
  ("Building your addenda…" / "Please wait, this may take a moment").

## Verify
- Multi-select 2+ vehicles → Print Now / Info Sheet / Buyer Guide → the overlay
  shows the spinning tire (animating) on navy with the text beneath.
- No console 404 for `/datire_loader.svg`.
- Stop for review before deploy.
