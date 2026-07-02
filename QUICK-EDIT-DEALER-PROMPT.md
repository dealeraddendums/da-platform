# Quick Edit Dealer — CC Prompt

> Ready-to-hand-to-Claude-Code prompt. Authored 2026-06-17.
> Adds a super_admin "Quick Edit" modal on the Dealers list to change a dealer's
> **subscription type, feed provider, and inventory ID** fast — reusing existing safe
> routes, no new write paths. Decided: modal (not inline), one dealer at a time.

---

TASK: Add a super_admin **"Quick Edit"** action to the Dealers list (`components/DealerList.tsx`)
that opens a compact modal to change a dealer's **subscription type**, **feed provider**, and/or
**inventory ID** — fast, without opening the full profile, and uniformly whether or not the dealer is
in a group. This is a faster front-end to routes/edits that already exist; **do not add new write
paths** to `account_type`, `inventory_provider`, or `inventory_dealer_id`.

## First, read to confirm exact shapes (don't assume)
- `app/api/dealers/[id]/route.ts` — the dealers PATCH. Confirm: it accepts `account_type` (super_admin
  only) and fires the HubSpot sync; it accepts `inventory_provider` + `inventory_provider_is_dms`
  (super_admin + group_admin, ~lines 204–208); and it must **not** push a price to da-billing.
  ⚠️ It also *accepts* `inventory_dealer_id` as a plain field write — **do NOT use that path** for the
  inventory ID (it skips vehicle deactivation). Inventory ID goes through the dedicated route below.
- `app/api/dealers/[id]/inventory-dealer-id/route.ts` — the existing **two-phase** super_admin route.
  Phase 1 (`confirm:false`) returns `{ vehicle_count }`; Phase 2 (`confirm:true`) updates the ID,
  **deactivates all the dealer's `dealer_vehicles`**, and logs to `migration_log`. Confirm body + response.
- `lib/inventory-providers.ts` — `DMS_PROVIDERS`, `OTHER_PROVIDERS`, `isDmsProvider()`. The canonical
  vendor list + the DMS classifier.
- `components/DealerProfileCard.tsx` (~375–396 save, ~808–880 dropdown) — the existing inline Feed
  Provider editor. **Mirror it exactly:** a `<select>` with optgroups "DMS Providers" / "All Other
  Providers", plus a blank "— none —" option; on save set `inventory_provider = value || null` AND
  `inventory_provider_is_dms = isDmsProvider(value)` together (never diverge; both go null when cleared).
- `components/DealerList.tsx` — reuse `SUBSCRIPTION_OPTIONS` (`sub-manual`/`sub-auto-web`/`sub-auto-dms`)
  + `subscriptionLabel()`. Slot "Quick Edit" alongside the existing row actions (Edit / Ghost /
  Impersonate); keep "Edit" (full profile) as-is — Quick Edit is the lightweight 3-field path.

## Modal (super_admin only — matches the row actions + the two super_admin fields)
Header: dealer name + group name (context only; no group switch required). Three independently-saved
fields (the ask is "and/or"):

1. **Subscription type** — dropdown from `SUBSCRIPTION_OPTIONS`, defaulted to current `account_type`.
   Save → PATCH `account_type`. Passive note: *"Updates the platform tier + HubSpot. If their billing
   plan/price changes, update the template in da-billing too."* (must not re-price.)
2. **Feed Provider** — dropdown from `inventory-providers.ts` (DMS / Other optgroups + "— none —"),
   defaulted to current `inventory_provider`. Save → PATCH `inventory_provider` **and** the derived
   `inventory_provider_is_dms` (via `isDmsProvider`). Clean dropdown, no confirm. (Provider + inventory
   ID are the feed pair — a dealer switching vendors usually changes both, so group them in the UI.)
3. **Inventory ID** — text field pre-filled with `inventory_dealer_id`. On save, **only if it actually
   changed**, use the **two-phase route**: phase 1 → show the confirm with the real count *"Changing the
   inventory ID will deactivate N active vehicles; they'll re-sync from the new feed on the next sync.
   Continue?"* → on confirm, phase 2. **Never deactivate inventory on a no-op save.**

Update the row in place on each successful save; surface any error inline (don't fail silently).

## Verify before deploy
- super_admin-only visibility.
- Subscription change reflects in the row + HubSpot, does **not** touch da-billing pricing.
- Feed Provider: a DMS vendor sets `is_dms=true`, a non-DMS sets false, "— none —" nulls both; the
  change reflects in HubSpot `feed_company` / `feed_company_type`.
- Inventory-ID change shows the correct count and deactivates only on confirm; a no-op save fires nothing;
  inventory ID never goes through the plain PATCH.
- A grouped dealer edits identically to a standalone one.
- **STOP and show me the modal + the diff before deploying** (Dealers list is high-traffic and the
  inventory route is destructive to inventory).
