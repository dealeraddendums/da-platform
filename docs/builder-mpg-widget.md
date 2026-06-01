# Feature — MPG (City / Highway) builder widget

> For Claude Code. Owner: Allan. 2026-06-01.
> A draggable widget that prints the vehicle's City + Highway MPG numbers over the
> blank spots in the infosheet's EPA fuel-economy graphic. The background supplies
> the "CITY"/"HWY" labels + pump art — the widget renders **only the two numbers**.

## Data source (confirmed)
`dealer_vehicles` already has `cmpg`, `hmpg`, `mpg` (text, lib/db.ts:1011–1013).
The render `vehicleData` shape already reserves `CMPG / HMPG / MPG`
(lib/vehicles.ts:31–33).

## ⚠️ Part A — wire the data first (or the widget prints blank)
Every place that builds `vehicleData` currently **hardcodes the MPG fields to
null**. Map them from the `dealer_vehicles` row (`dv.cmpg / dv.hmpg / dv.mpg`):
- `app/api/pdf/generate/route.ts:344–346`
- `app/api/pdf/bulk/route.ts:639`
- `app/(dashboard)/vehicles/[id]/addendum/page.tsx:72–74`
- `app/(dashboard)/dealer-vehicles/[id]/addendum/page.tsx:83–85`
- `app/api/options/[vehicleId]/route.ts:72–74`
Change `HMPG: null, CMPG: null, MPG: null` → `HMPG: dv.hmpg ?? null, CMPG:
dv.cmpg ?? null, MPG: dv.mpg ?? null`. (If a shared `dv → vehicleData` mapper
exists in `lib/vehicles.ts`, fix it once there; otherwise these 5 inline sites.)

## Part B — the widget (follow the existing widget pattern)
A new widget type `mpg`, built like the other content widgets (catalog →
`renderW()` → inspector panel; both canvas + PDF go through `renderW`, the single
renderer).

1. **`components/builder/constants.ts`**
   - Catalog entry: `{ type: 'mpg', emoji: '⛽', label: 'MPG', hint: 'City /
     Highway', group: 'infosheet' }` (infosheet group — that's where the fuel
     graphic lives; see "Availability").
   - Default data: `{ order: 'city_first', fontSize: 1.0, gap: 120 }`
     — `order: 'city_first' | 'hwy_first'`; `fontSize` is a scale like the other
     font widgets; `gap` = px between the two numbers (straddles the center pump
     art). Add a `LAYOUT_INFOSHEET['mpg']` default position.
   - `WIDGET_LABELS`: `mpg: 'MPG'`.
2. **`components/builder/widgetRenderer.ts` (`renderW`)**
   - Render two numbers from `vehicle.CMPG` and `vehicle.HMPG`, ordered by
     `d.order` (`city_first` → City then Highway; `hwy_first` → reversed),
     separated by `d.gap` px, at `d.fontSize`. **No labels** (the background has
     them). Apply the Hide-If-Empty rule: skip a number that's null/empty; render
     nothing if both are empty.
3. **`components/builder/BuilderPage.tsx` (`WidgetEditPanel`)** — per the Inspector
   Panel Layout convention:
   - Widget-specific settings: an **Order** toggle — "City first" / "Highway
     first" (the reversible CMPG/HMPG ↔ HMPG/CMPG requirement).
   - **Font Size**: add `'mpg'` to the set of types that get the Font Size
     EpSection.
   - **Spacing**: a numeric/stepper control for `gap` (its own row/section, like
     the Line Spacing stepper) — the adjustable spacing between the two numbers.

## Availability
Put it in the **infosheet** group (Allan's use case + where the fuel graphic is).
The EPA/DOT fuel block also appears on addendum backgrounds — if you want MPG on
addendums too, give it `group: 'dynamic'` (or don't hide it in either palette
branch) instead of infosheet-only. Flagged; default infosheet-only.

## Verify
- On an infosheet template, drag the MPG widget over the fuel graphic; it shows
  the vehicle's city/highway numbers (e.g. 12 / 22) from `dealer_vehicles`.
- Toggle Order → the two numbers swap sides. Adjust font size + gap → both numbers
  scale / the gap widens to clear the center art.
- Print a vehicle that has cmpg/hmpg → numbers appear in the PDF (proves Part A).
- A vehicle with no mpg data → widget renders nothing (no "null").
- Stop for review before deploy.
