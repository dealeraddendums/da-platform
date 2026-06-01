# Team walkthrough tweaks (Alex / Marlena / Claire) — 2026-06-01

> For Claude Code. Small UI/UX changes from the platform walkthrough. Append new
> items as Allan sends them. Each is independently shippable.

## #1 — Tooltip on the group-locked product lock icon
On the Addendum details page, a group-locked corporate product shows a 🔒 with no
remove button. Add a hover tooltip explaining why.
- File: `components/AddendumEditor.tsx` (~line 452, `{unlocked ? "🔓" : "🔒"}`;
  `unlocked = opt.locked === false`).
- Change: when locked, add `title="Contact your Group Administrator to make changes
  to this product"` on the lock element (e.g. wrap the 🔒 in a `<span title={…}>`).
  Leave the unlocked 🔓 as-is (it already has its own remove-button title at ~480).
- Trivial; no backend.

## #2 — Bulk "Clear Print History" for selected vehicles
On the dashboard inventory list, add a **Clear Print History ({n})** button to the
bulk-action bar next to Print Now / Info Sheet / Buyer Guide / Delete.
- UI: `components/VehicleInventory.tsx` — bulk bar at ~lines 317–349 (uses
  `checkedIds`). Add the button (style it like the others; not red — it's not a
  delete). Show a **confirmation dialog** ("Clear print history for N vehicles?")
  since it's bulk + not easily undone.
- Backend: new `POST /api/print/clear-history` taking `{ vehicleIds: string[] }`,
  mirroring the per-dealer logic in `app/api/dealers/[id]/clear-print-history/route.ts`
  but scoped to the selected ids:
  - Permissions: dealer_admin/dealer_user → only their own dealer's vehicles;
    super_admin → any. Verify every vehicleId belongs to the caller's dealer.
  - **Full reset (confirmed 2026-06-01), scoped to the selected ids only** —
    mirror the per-dealer route exactly, but with `.in("vehicle_id", selectedIds)`
    everywhere instead of all-active vehicles: delete `print_history`; reset
    `dealer_vehicles` `print_status/print_info/print_guide = 0`,
    `print_date/print_user = null`; delete `addendum_data` (by dealer UUID + the
    ids); delete `vehicle_options` (saved products/overrides) for those ids; log
    `vehicle_audit_log` action `print_history_cleared`.
  - **⚠️ Do NOT delete the legacy `vehicle_id = '0'` sentinel `vehicle_options`.**
    The per-dealer route deletes it because it clears the *whole* dealer; here it's
    dealer-wide shared legacy options and would wrongly wipe products on
    NON-selected vehicles. Scope strictly to the selected ids.
- **Confirm dialog must be explicit** that it's a full reset, e.g. "Clear print
  history **and saved products** for N vehicles? This can't be undone." (Matches
  the existing route's behavior; not just a printed/unprinted status flip.)
- On success, refresh the list + dashboard counts (Printed this month / Unprinted)
  so cleared vehicles flip back to unprinted.

## #3 — Header buttons unreadable on the dealer profile (HubSpot + Deactivate)
On the super-admin Dealer Profile header (blue `--bg-app` #3a6897 background), the
**HubSpot ↗** pill and **Deactivate** button are low-contrast — transparent/ghost
styling with grey text on blue (the same "never use btn-secondary on `--bg-app`"
trap from the fix history).
- File: `components/DealerProfileCard.tsx`.
  - `HubSpotPill` (~lines 29–53): currently `background: transparent`, grey border
    `#c0c0c0`, grey text `#78828c`. Make it a **solid white pill** with HubSpot
    orange text + border (`#ff7a59`) — readable on blue, keeps the brand cue.
  - **Deactivate** button (header row near the Active badge / Edit Profile): give
    it a **solid white background** with danger text + border (`#ff5252`) so it
    reads on blue and signals caution. (Leave the green "Active" badge and the
    solid-blue "Edit Profile" as-is — already readable.)
- Pure styling; no logic change.

## #4 — Consistent toggle colors in Configure Product (white = off, blue = on)
The Configure Product toggle groups use mixed colors (green/orange), which reads as
"everything's selected." Standardize them all to the **Applies To** convention
that's already correct: **selected = blue** (`border #1976d2`, `bg #e3f2fd`,
`text #1976d2`), **unselected = white** (`border #e0e0e0`, `bg #fff`, `text #55595c`).
- File: `components/OptionsLibrary.tsx` (`OptionForm`):
  - **Applies To** (~360–368) — already correct; use it as the reference style.
  - **Product Type** Required/Suggested (~331–334) — drop the green/orange
    `active/activeText/activeBorder`; use blue-selected / white-unselected.
  - **Type** New/Used/CPO (~381, the `row("Type", …)` block) — same; drop the
    per-condition green/blue/orange. **Preserve the existing select behavior** (if
    Type is multi-select, each chosen one is blue) — only the colors change.
- Apply the identical change to **`components/CorporateProductModal.tsx`** (group
  product version has the same controls). Factor the toggle style into one shared
  object so the two modals stay in sync.

## Notes
- All four stop for review before deploy; #3 and #4 are styling-only.
- More walkthrough items will be appended below as Allan sends them.
