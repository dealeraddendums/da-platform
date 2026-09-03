# Spec: Restyler / Upfitter account type

## Use case

A restyler/upfitter services ~40 stores, ~2-3 vehicles/month each (~80-120
addendums/mo total). 40 separate paid accounts don't pencil out. He needs ONE
account with unlimited per-store templates, printing each store's addendum from
that store's branding — billed as a single metered plan, with a locked
"created using dealeraddendums.com" attribution on every print.

## Account model — reuse the service-provider group pattern

Model him as a **service-provider group** (same shape as Dealer General /
Permaplate), with a new **`account_type = Restyler` (or a `groups.is_restyler`
flag)** that turns on the restyler-specific behavior:

- **One group account** ("Bob's Restyling"); he is the group_admin, the only
  operator (no per-store logins).
- **Each client store = a lightweight member "dealer"** under the group, created
  via the existing group New Dealer form with **no inventory feed** (optional
  inventory ID → interim id). Manual VIN entry / VIN decode for the few vehicles
  a month (the Add Vehicle flow already does this).
- **Per-store templates:** each store has its own template(s) with that store's
  logo/branding/products, built in his Builder. Unlimited stores/templates.
- He prints each store's addendum from that store's template via Switch to Dealer.

**This is ~90% existing plumbing** — group model, group-admin-operates-dealers,
per-store templates, optional-inventory-ID lightweight store creation, manual VIN
decode/Add Vehicle, group self-service. The new work is below.

## NEW #1 — Metered billing: $150/mo floor OR $2/addendum, whichever is greater

One da-billing customer for his whole group (all stores group-billed to it — NO
per-store subscriptions). It's a **metered plan**, computed AT INVOICE TIME:

- At his monthly invoice generation (the da-billing daily cron on his cycle date):
  count the **addendums printed by his account during the cycle** (across ALL his
  member stores), then invoice **`max(150, count × 2)`**.
  - ≤75 addendums → $150; >75 → $2 each (e.g. 100 → $200).
- **Count source:** da-billing requests the cycle's addendum count from da-platform
  at invoice time via a new secret-gated endpoint (e.g. `GET /api/billing/print-
  count?group={id}&from=&to=`, same webhook-secret pattern as the dealer-names /
  cache-invalidate endpoints). da-platform sums confirmed prints (recordPrint /
  print_history, the Send/Download confirm — not previews) across his stores in
  the window.
  - **DECISION for Allan (count basis):** count **distinct vehicles printed in
    the cycle** (recommended — matches "2-3 vehicles/mo", so a reprint of the same
    vehicle doesn't double-charge) vs **every print event**. Default: distinct
    vehicles. Confirm.
- da-billing needs a plan TYPE that resolves its amount from usage at generation
  rather than a fixed subscription amount. Existing fixed plans (Manual/Automatic
  Web/DMS) are unchanged.
- Setup/Live billing state, past-due lock, invoice email/print — all the normal
  da-billing machinery applies to this one customer.

## NEW #2 — Locked "created using dealeraddendums.com" attribution

Every addendum printed from a Restyler account carries a **non-removable**
attribution line — e.g. "This addendum created using dealeraddendums.com" — that
he cannot delete or hide in the Builder. Reuse the existing disclaimer/watermark
machinery; force it on for the restyler account type at render time (canvas +
PDF), like the standard "THIS ADDENDUM HAS BEEN ADDED BY THE DEALER…" disclaimer.
- **DECISION for Allan:** exact wording + placement (footer small-print vs a
  visible band). Default: small footer line under the existing disclaimer.
- Locked = present in the render regardless of template; not an editable/removable
  widget (sample-injection discipline still applies — it's a real forced element,
  written into the render for this account type).

## NEW #3 — The `Restyler` account-type flag

A single flag ties it together: unlimited lightweight stores, group-billed to the
one metered customer, locked attribution, no per-store logins. It also lets the
console / lists label him as a Restyler and keeps him OUT of the normal per-dealer
subscription and trial-conversion metrics (he's a distinct model — like the
group-billed exclusion).

## What's reused vs new

- **Reused:** group + group-admin-operates-dealers, per-store templates, Switch to
  Dealer, lightweight store creation (optional inventory ID), manual VIN
  decode/Add Vehicle, group self-service, da-billing customer/setup-Live/past-due.
- **New:** metered plan (#1) + the print-count endpoint, locked attribution (#2),
  the Restyler account-type flag (#3).

## Decisions needed from Allan

1. **Count basis** — distinct vehicles printed per cycle (recommended) vs every
   print event.
2. **Attribution wording + placement** (default: "This addendum created using
   dealeraddendums.com", small footer).
3. Any per-store cap, or truly unlimited stores? (Default: unlimited.)
4. Partial first month — prorate the $150 floor or full floor from day one?
   (Default: full floor.)

## Build phases (for CC, once decisions confirmed)

- **Phase 1 (mostly reuse):** Restyler account-type flag; confirm lightweight
  store creation + unlimited per-store templates work under it; locked attribution
  on render (canvas + PDF). Ships value without billing.
- **Phase 2 (metered billing):** da-platform print-count endpoint (secret-gated,
  distinct-vehicles-per-cycle across his stores); da-billing metered plan that
  computes `max(150, count×2)` at invoice generation; his group customer set to
  it. Verify one full cycle on a test account before go-live.

## Verification

- A Restyler group with 2-3 lightweight stores, each its own template → prints
  carry the locked attribution (canvas + PDF, pdftotext-confirmed); he can't
  remove it.
- Metered invoice: with N distinct vehicles printed in a cycle, invoice =
  max(150, N×2); floor at ≤75, per-addendum above; count scoped to HIS stores
  only.
- He is excluded from per-dealer subscription + trial-conversion metrics.
- Existing dealers/groups/plans unaffected.
