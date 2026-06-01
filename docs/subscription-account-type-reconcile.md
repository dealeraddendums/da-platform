# Platform `account_type` out of sync with da-billing (shows "Free")

> For Claude Code. Owner: Allan. 2026-06-01.

## Diagnosis (confirmed)
The Dealers list "Subscription" column is `subscriptionLabel(d.account_type)`
(`components/DealerList.tsx:548`). `subscriptionLabel` (lines 60–63) maps a known
set (`sub-auto-web`, `Monthly Subscription Automatic Web`, `Manual`, `Trial`, …)
and **collapses everything else — null, `"Free"`, and legacy strings — to
"Free"**. Legacy migration sets `account_type` from Aurora `ACCOUNT_TYPE` and
**defaults to `"Standard"` when null** (`scripts/import-dealers.ts:139`), which
isn't in the map → renders **Free**. da-billing meanwhile holds the real template
(Automatic Web, $150). So the platform's `account_type` is stale/unmapped; billing
is correct.

## ⚠️ Why this matters beyond the display — it mis-feeds the new HubSpot sync
`account_type` also drives the Phase-14 HubSpot fields:
`isPayingAccount("Standard"|"Free"|null)` is **false** → the sync sets
`lifecyclestage = Dealer Trial` and `subscription_type = null`. So **every paying
legacy dealer whose `account_type` is unmapped is being synced to HubSpot as a
Trial, not a Customer** — which can wrongly enroll real customers in Alex's
trial/onboarding workflows. Fixing `account_type` fixes the list, the billing
descriptor, *and* the HubSpot classification in one go.

## Source-of-truth note
Normally Platform `account_type` → da-billing (platform leads). For **legacy**
dealers the da-billing template (migrated from FreshBooks) is the accurate record
and the platform value is what drifted, so this is a **one-time reconcile of
platform ← billing**. After it, platform resumes as source of truth (operators
change the plan on the platform, which syncs out).

## Immediate fix — this dealer
Set Advantage Acura of Naperville's `account_type` to **`sub-auto-web`** (the
canonical productId form; renders "Automatic Web" and resolves via
`subscriptionDescriptorFor`). It'll then show correctly and re-sync to HubSpot as
`Customer` / `Auto-Web`.

## Audit first (read-only) — size the problem
Before any bulk write, a read-only script (pattern: `hubspot-dup-count.mjs`):
- For each active dealer, read its da-billing template (`getTemplate(customerId)`,
  customerId = `dealer.billing_customer_id ?? dealer.internal_id`) and extract the
  subscription line item's productId / plan.
- Compare to `subscriptionDescriptorFor(dealer.account_type)`.
- Report the mismatches, especially **"platform shows Free/Standard/null but
  da-billing has an active subscription"** (the overcharge-risk-free, display-wrong
  case) and the reverse ("platform has a plan but billing has none" —
  under-billing risk). Output counts + a sample list.
- ⚠️ Freshbooks token caveat does NOT apply (this is da-billing's own API), but
  pace requests like the other scripts.

## Reconcile (after reviewing the audit)
For each confirmed mismatch where billing is authoritative, set
`dealers.account_type` to the billing plan's productId (`sub-manual` /
`sub-auto-web` / `sub-auto-dms`). Then a normal dealer save (or a one-shot HubSpot
re-sync of those ids) corrects the HubSpot lifecyclestage/subscription_type.
Dry-run → review → apply, like the dedup tool.

## Verify
- This dealer flips to "Automatic Web" on the list; its HubSpot company shows
  `subscription_type=Auto-Web`, `lifecyclestage=customer`.
- Audit re-run shows the mismatch count drop to ~0.
- A genuinely free/trial dealer still shows Free/Trial (don't over-correct those —
  only reconcile where da-billing has a real subscription).
