# Per-vehicle product edit (Addendum Details view)

> For Claude Code. Owner: Allan. Created 2026-06-10. da-platform only; **no migration, no API
> change** — UI-only. Can ship in the training-fixes batch.

## Ask
On the Addendum Details view for a specific vehicle, **edit a product's fields for THIS vehicle
only** (price, name, description, required) — alongside the existing × Remove. Must **not** change
the global library product, only this vehicle's version.

## Why it's UI-only (the data layer already does this)
The per-vehicle option set is materialized in **`vehicle_options` rows keyed by `vehicle_id`**, each
carrying its own `option_name` / `option_price` / `description` / `required` / `sort_order` / `source`
(see `app/api/options/[vehicleId]/route.ts`). **`POST /api/options/[vehicleId]` is a replace-all** of
that set — it's what the existing × Remove and "+ Custom" / "+ From Library" already use. So editing a
line's fields and re-saving the set persists a **per-vehicle override**; `addendum_library` (the
global product) is never touched. No schema or endpoint change needed.

## UI (`components/AddendumEditor.tsx`)
- Add an **Edit** (pencil) action on each product row, next to the × Remove.
- It opens the product-config modal **pre-filled with that row's current values** — `option_name`,
  `option_price`, `description`, `required` (+ separators / spaces). **Hide the Applies-To / Type /
  assignment-rules section** — those control *global* targeting and are moot for a line already on
  this vehicle. Label it clearly: **"Editing for this vehicle only — does not change the global
  product."**
- On **Save**: update that line in AddendumEditor's local list → call the existing
  `POST /api/options/[vehicleId]` (replace-all) → the per-vehicle `vehicle_options` row is updated.
- The edited description must run through **`sanitizeProductDescription`** (the same render path) so
  bullets/lists/font-size survive (per the description fix).

## Gating (mirror Remove)
Show Edit for the **dealer's own products + unlocked corporate** ones; **not for locked corporate /
group** products (the group controls those — same rule the × Remove uses).

## Behavior note (expected, consistent with add/remove)
Editing — like the existing add/remove — **pins this vehicle's option set**: once saved it's a
per-vehicle snapshot, detached from future `addendum_library` auto-updates for this vehicle. That's
the existing behavior whenever a vehicle is customized, not new.

## Verify
- Edit Window Tint's **price + description** on this Jeep → Save → it shows changed on **this
  vehicle's** Addendum Details + printed addendum/infosheet.
- The global **Window Tint** in Products is **unchanged**; a **different** vehicle's Window Tint is
  unchanged.
- A **locked corporate** product shows **no** Edit affordance.
- An edited description with **bullets/size/color** round-trips (sanitizeProductDescription).
- STOP for review.
