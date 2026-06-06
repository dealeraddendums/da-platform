# Bug — group bill-to never migrated (all group dealers show Dealer/Dealer)

> For Claude Code. Owner: Allan. Created 2026-06-05.
> On a group page (e.g. **Dealer General**, 196 dealers), every member shows
> **Subscription: Dealer / Labels: Dealer** — but the legacy "Edit Dealer" modal has
> **Sub Bill To: Group / Label Bill To: Group** (the group pays for its dealers).

## Root cause (data gap, not display)
There are **two parallel sets of bill-to columns**, and the ones the app uses were never
populated from legacy:
- **Aurora `dealer_dim.SUB_BILLING_TO` (subscription) + `BILLING_TO` (labels)** — legacy
  source of truth; values `'Dealer'`/`'Group'`.
- **Migration 024**: `dealers.sub_billing_to` + `dealers.billing_to` (`varchar(20)
  DEFAULT 'Dealer'`) — populated **only** by the one-time legacy import
  (`scripts/export-legacy.ts` → `import-dealers.ts`).
- **Migration 067**: `dealers.subscription_billed_to` + `dealers.labels_billed_to`
  (`text DEFAULT 'dealer'`, CHECK in `('dealer','group')`) — **what the app reads/writes**
  (`GroupProfileCard` `BillingRoutingCell` lines ~698–726; `GroupDealerList` NewDealerForm).

067 added the new columns with a `'dealer'` default and **never backfilled** them from the
024 columns (or Aurora). The **ETL syncs neither set** (`da-legacy-etl/src/jobs/dealers.ts`
has no bill-to fields). So the 067 columns sit at `'dealer'` for every dealer → the group
table faithfully shows Dealer/Dealer. `BillingRoutingCell` reads `d.subscription_billed_to`
/ `d.labels_billed_to` directly, so the display is correct — the data is wrong.

## Fix

### 1. Audit (read-only — report before any write)
For **every dealer with a `group_id`** (all groups, not just Dealer General), compare the
authoritative Aurora value to Supabase:
- Aurora `dealer_dim.SUB_BILLING_TO` vs `dealers.subscription_billed_to`
- Aurora `dealer_dim.BILLING_TO` vs `dealers.labels_billed_to`
Match Supabase ↔ Aurora on `dealers.inventory_dealer_id` = `dealer_dim.DEALER_ID` (the ETL's
key). Normalize case (`'Group'`→`'group'`, `'Dealer'`→`'dealer'`). Report per-group mismatch
counts + a CSV (dealer, group, aurora sub/label, supabase sub/label). Note any group dealer
whose Aurora row can't be matched.

### 2. Backfill (write — after the audit is reviewed)
Set the **067** columns from **Aurora `dealer_dim`** (authoritative — covers ETL-only
dealers whose 024 columns are stale at default), normalizing case to `dealer`/`group`:
- `subscription_billed_to` ← `SUB_BILLING_TO`
- `labels_billed_to` ← `BILLING_TO`
**Verify the mapping direction first** on a known dealer — **Al Packer's White Marsh Ford
(inventory id 21924)** is **Group/Group** in the legacy modal — and on any dealer whose sub
vs label differ, before the bulk update. Scope to group dealers (`group_id IS NOT NULL`);
leave standalone dealers alone (their `'dealer'` default is correct).

### 3. Functional correctness — group needs a da-billing customer
Per migration 067 + `lib/group-billing-cascade.ts`, a dealer billed to `'group'` routes its
line items to the **group's** da-billing template, which requires
`groups.billing_customer_id`. After the backfill, for **every group with ≥1 group-billed
dealer**, ensure the group has a `billing_customer_id` (create the da-billing group customer
via the existing cascade path if missing) so subscription/label charges actually land on the
group. Report any group still missing it — otherwise bill-to says "group" but billing has
nowhere to route.

### 4. Going forward — do NOT add bill-to to the ETL
The new platform is source of truth for bill-to (super_admin/group_admin edit it via
`BillingRoutingCell`). This is a **one-time backfill**, not an ongoing ETL sync — syncing it
nightly would clobber new-platform edits (same lesson as the profiles-overwrite bug). Legacy
continues FreshBooks billing until each dealer's cutover.

## Verify
- Al Packer's White Marsh Ford (21924) → Group/Group; Dealer General's 196 reflect their
  real Aurora values; a standalone (non-group) dealer stays Dealer/Dealer.
- Each group with group-billed dealers has a `billing_customer_id`.
- Re-run the audit → 0 mismatches.
- Read-only audit first; STOP for review; then backfill; STOP before any da-billing customer
  creation.
