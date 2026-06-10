# Account-purpose classifier (Real / Test / Sales Demo) — flag at creation

> For Claude Code. Owner: Allan. Created 2026-06-08. Root-cause fix for the test/demo pollution we
> hand-swept this session: nothing flags a test or sales-demo account at creation, so they slip into
> BI / billing / HubSpot until someone notices. Make it a creation-time choice.

## Model
- Add **`dealers.account_purpose text NOT NULL DEFAULT 'real'`**, `CHECK (account_purpose IN
  ('real','test','sales_demo'))`. Migration **~096** (confirm next free — 095 was `converted_at`).
- **Keep `is_test` as THE exclusion gate** (it's already wired through BI, billing, HubSpot). Set
  **`is_test = (account_purpose <> 'real')`** whenever purpose is set or changed — so nothing that
  already checks `is_test` needs rewiring. `account_purpose` just adds the **test-vs-demo
  distinction** (and enables a future "sales demos created" cut without conflating demos with QA).
- (Groups can be left out for now — group test/demo is rare; add `groups.account_purpose` later if
  needed. Note it, don't build it.)

## Where
- **super_admin dealer-create** (the Dealers → New flow + `POST /api/dealers`): add a **Purpose**
  selector — **Real (default) / Test / Sales Demo**. On create, persist `account_purpose` and set
  `is_test` accordingly. Real is the default so normal creates are unaffected.
- **Self-serve signup provisioning** (`lib/provisioning.ts → createTrialDealer`): always `'real'`
  (real trials) — no UI.
- **Existing super_admin dealer PATCH `is_test` toggle:** keep it, but surface `account_purpose`
  there too (editing purpose recomputes `is_test`); a small purpose badge on the dealer profile is
  a nice-to-have.

## Backfill (one-time, so classification is complete from day one)
- The QA/test fixtures already flagged `is_test=true` this session → `account_purpose = 'test'`.
- The **8 sales demos** (Andre / Asher Enterprises / Tyler Jorgensen / CA ClearBra / Millennium
  Dealer Services / CDS Zoom / STARSHIELD / Toyota Demo) → `account_purpose = 'sales_demo'`.
- Everything else → `'real'` (the column default already covers it).

## Verify
- Creating a dealer as **Test** or **Sales Demo** sets `is_test=true` + the purpose, and it's
  excluded from BI / billing / HubSpot; a **Real** dealer is included and `is_test=false`.
- Editing purpose on an existing dealer recomputes `is_test` both directions.
- Post-backfill: the 8 demos read `sales_demo`, the QA fixtures read `test`, everyone else `real`;
  BI counts are unchanged (they already excluded these via `is_test`).
- STOP for review before deploy (touches dealer-create + a migration).
