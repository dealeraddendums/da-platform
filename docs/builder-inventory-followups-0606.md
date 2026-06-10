# Builder + inventory follow-ups (2026-06-06)

> For Claude Code. Owner: Allan. Found while testing as a **group_admin switched into a
> member dealer** (Robert → Mercedes Benz of Collierville). Items 1–2 are the same
> group-admin-as-dealer theme; 3–4 are features.

## 1. No Custom Size for a group_admin acting as a member dealer
A switched-in group_admin sees no Custom Size option in the Builder paper-size dropdown.
**Not a regression** — two pre-existing gates exclude group_admin:
- `app/(dashboard)/builder/page.tsx` (~line 106): `canAddCustomSize={role === 'super_admin'
  || role === 'dealer_admin'}` — group_admin excluded.
- `POST /api/custom-sizes` (~line 53): `if (dealer_user || group_admin) → 403`.
(The GET already works — it group-checks and the active dealer is in-group.)

**Fix (per Allan's "group_admin manages a member dealer while switched in"):** let a
group_admin **with an active dealer** add/use custom sizes for that dealer.
- `builder/page.tsx`: include group_admin in `canAddCustomSize` when `active_dealer_id` is set
  (i.e. acting as a dealer). The page already resolves the active dealer to `dealerId` (~64–70).
- `POST /api/custom-sizes`: allow a group_admin scoped to their **active dealer** — resolve
  `claims.dealer_id` (the active dealer) + the defensive `group_id === claims.group_id` check,
  mirroring the template-save fix — instead of the blanket 403. `PATCH/DELETE /api/custom-sizes/[id]`
  should authorize the same way (group-verify the row's dealer).

## 2. Bulk "Clear Print History" → Forbidden for a group_admin-as-dealer
`POST /api/dealers/[id]/clear-print-history` (lines ~22–28) allows `dealer_admin`/`dealer_user`
(own dealer) and `super_admin`; a **group_admin falls into `else → 403`**. (Individual
per-vehicle clear works — different route.)
**Fix:** add a group_admin branch — allow when the target dealer (`params.id`) is in
`claims.group_id` (look up the dealer's `group_id`, 403 on mismatch), same pattern as the
read-scope fixes. The active dealer they're switched into is in-group, so it passes.

## 3. Add City MPG / Highway MPG to the vehicle editor + VIN-decode populate
The Edit Vehicle modal has no MPG fields, yet `cmpg`/`hmpg` already exist on the vehicle data
(the MPG infosheet widget reads `vehicle.cmpg` / `vehicle.hmpg` — see `builder-mpg-widget.md`).
- Add **City MPG** and **Highway MPG** numeric inputs to the Edit Vehicle form (and the Add
  Vehicle form if separate); persist to `dealer_vehicles.cmpg` / `hmpg`.
- In the **VIN decoder** path (the decode used on add/enrich), populate `cmpg`/`hmpg` when the
  decoder returns them; leave blank when unavailable (manual entry fills the gap). Don't
  overwrite a non-null manually-entered value on re-decode.

## 4. Persist inventory filters
The inventory list filters (**Condition**, **Print Status**, and the search box) reset on
navigation/reload. Persist them — `localStorage` keyed per dealer (or user), restored on mount —
so a dealer's chosen filter sticks across reloads and returning to the page. (URL query params
are an acceptable alternative if you'd rather they be shareable/back-button friendly.)

## Verify
- group_admin switched into a member dealer: **Add Custom Size** works (creates under that
  dealer, appears in the dropdown); **bulk Clear Print History** succeeds (no 403); both still
  403 for a dealer outside the group / unauthorized roles.
- Edit Vehicle shows City/Highway MPG, saves them, and they flow to the MPG widget; VIN decode
  fills them when available.
- Inventory filters survive a reload and leaving/returning to the page.
- A real dealer_admin and super_admin are unaffected throughout.
- Stop for review before deploy.
