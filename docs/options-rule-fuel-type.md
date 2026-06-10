# Add "Fuel Type" rule to product-assignment rules

> For Claude Code. Owner: Allan. Created 2026-06-08. A new **Fuel** filter in Configure Product →
> "Assign with Rules" — a multiselect populated by the distinct `dealer_vehicles.fuel` values, with
> an **IN / NOT IN** toggle, mirroring Make/Model/Trim end-to-end.

## Touch points (mirror the existing make/model/trim dimension exactly)

1. **Migration (next free — confirm; recent: 094 etl_config_lock, 095 converted_at, ~096
   account_purpose).** Add **`fuel text`** + **`fuel_not boolean NOT NULL DEFAULT false`** to **every
   table that carries the `makes`/`makes_not` rule columns** — i.e. the option/rule store(s) read &
   written by `app/api/options/[vehicleId]/route.ts` and `app/api/addendum-library/route.ts`
   (`vehicle_options` + `addendum_library` + any group-scoped variant). `NULL`/`false` defaults mean
   existing rules behave as "All fuels" — no behavior change for current products.

2. **Fuel options source — CURATED canonical list (decided 2026-06-08; NOT a DB scan).**
   Verification found `dealer_vehicles.fuel` is **~95% garbage** — 428 distinct values (HTML
   fragments, numbers/weights/prices, colors, packages, marketing copy), only **~20–30 real fuels**
   mixed in. A raw distinct dropdown is unusable. Instead, `GET /api/vehicles/fuel-types` serves a
   **fixed curated list** of real fuels: **Gasoline, Diesel, Hybrid, Plug-in Hybrid, Electric, Flex
   Fuel, Hydrogen, CNG, Propane** (extend in code as needed).
   **Each option carries a set of lowercase substring keywords** (synonyms) that are written into the
   `fuel` CSV on select, so the matcher (#3 — *vehicle value contains the keyword*) catches the feed
   variants without exposing any garbage. Build the keyword sets from the **~20–30 real fuel strings
   the distinct scan surfaced**, e.g.:
   - Gasoline → `gas` (catches Gas / Gasoline / GAS / Gasoline-E85)
   - Diesel → `diesel,dsl` · Hybrid → `hybrid,hev` · Plug-in Hybrid → `plug-in,plugin,phev`
   - Electric → `electric,bev` · Flex Fuel → `flex,e85,ffv` · Hydrogen → `hydrogen,fcev,fuel cell`
   - CNG → `cng,compressed natural` · Propane → `propane,lpg`

   The dealer sees clean labels ("Electric"); the stored CSV is the keyword set so substring matching
   still catches "BEV"/"EV"/etc. (The migration-097 `distinct_vehicle_fuels()` fn can stay for a
   future data-quality audit or be dropped — it is no longer the dropdown source.)

3. **Engine — `lib/options-engine.ts`.** Add `fuel` + `fuel_not` to the rule interface (top) and to
   `RulesRow`; add a match line mirroring makes/models/trims:
   ```ts
   if (!listMatchesWithNot(vehicle.FUEL, row.fuel ?? null, !!row.fuel_not)) return false;
   ```
   Ensure the **`VehicleRow` handed to the engine populates `FUEL`** from `dealer_vehicles.fuel`
   (map it wherever `MAKE`/`MODEL`/`TRIM`/`BODYSTYLE` are mapped). Preview **and** PDF render both go
   through this engine, so they inherit fuel matching for free.

4. **Save / read API.** Add `fuel` / `fuel_not` to the select + write + the engine-mapping in
   `app/api/options/[vehicleId]/route.ts` and `app/api/addendum-library/route.ts`, right alongside
   `makes` / `makes_not`.

5. **UI — Configure Product modal (`components/OptionsLibrary.tsx` + `components/CorporateProductModal.tsx`).**
   Add a **Fuel** row: a **multiselect** (checkbox-list / multi-select) populated by
   `/api/vehicles/fuel-types`, with an **IN / NOT IN** toggle in the label row (same control style as
   Make/Model/Trim). Place it logically after Trim / Bodystyle. Store the selection as a **CSV string**
   in `fuel` (e.g. `"Hybrid,Electric"` — the same CSV convention `listMatchesWithNot` splits on `,`)
   and the toggle in `fuel_not`. **Empty = all fuels** (consistent with the modal's "Leave any field
   empty to match all values" note). (Optional, to match Bodystyle's "+": allow a free-text add for a
   fuel not in the list — nice-to-have, not required.)

## Storage / semantics
`fuel` = CSV of selected values; empty/`NULL` = all. `fuel_not` = **IN** (`false`) / **NOT IN**
(`true`). Identical to the `makes`/`makes_not` pattern — `listMatchesWithNot` already handles the
CSV split + IN/NOT + the "empty matches all" case, so no new matching logic beyond the one line.

## ⚠️ Root-cause flag (separate data-quality task — does NOT block this feature)
`dealer_vehicles.fuel` being ~95% garbage means the **feed → `fuel` mapping is broken** (the
inventory pipeline — DA Pulse / the feed importer — is dumping HTML/numbers/colors/marketing copy
into the column). Implications beyond this rule: **any addendum/infosheet that *displays* fuel shows
garbage** for many vehicles, and a vehicle with a junk `fuel` value won't match a real fuel rule (the
product silently won't apply). Same class of feed pollution as the junk CMPG/HMPG noted earlier.
**Worth a separate investigation with Alex (Pulse owner)** into the feed field mapping. The curated
list sidesteps it for *this* feature.

## Verify
- Configure a product with **Fuel IN [Hybrid, Electric]** → applies only to those vehicles;
  **NOT IN [Gasoline]** → applies to everything except gas vehicles; **empty** → all fuels.
- **Existing products** (no fuel rule) behave exactly as before (`NULL`/`false` = all).
- The dropdown shows the **curated list** (clean labels), and selecting one catches the real feed
  variants (e.g. Electric catches BEV/EV) via the stored substring keywords.
- Matching holds in **both** the on-screen preview and the **printed** addendum.
- STOP for review before deploy (migration + engine + save path + UI).
