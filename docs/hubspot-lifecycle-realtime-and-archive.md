# Phase 14 follow-up — realtime sub/lifecycle sync + "Downgraded" + 60-day archive

> For Claude Code. Owner: Allan (from Alex). claude.ai session 2026-05-31.
> Amends the shipped Phase 14 sync. **Reuse** `lib/hubspot.ts`,
> `lib/sync-hubspot.ts`, `lib/billing.ts` — do not reimplement.

## Why
`subscription_type` and `lifecyclestage` are the two HubSpot properties Alex's
**workflows enroll off**, so they must reach HubSpot **immediately and reliably**
the moment they change — a silent fire-and-forget miss means a workflow never
fires. Plus a new lifecycle stage **Downgraded** (paying → Free) and a cron that
**archives** dealers stuck in Downgraded for 60 days, in DA-Platform **and**
da-billing.

## Current state (as built, commit 3222757)
- `LIFECYCLE` in `lib/hubspot.ts` already defines `ACCOUNT_DOWNGRADED:"108387744"`
  (also `TRIAL_EXPIRED`, `ACCOUNT_PAUSED`) — **the stage exists in the portal**;
  nothing sets it automatically yet.
- Lifecycle derivation (`dealerCompanyProperties`, sync-hubspot.ts ~line 76) is
  only `isPayingAccount ? CUSTOMER : DEALER_TRIAL`.
- `app/api/dealers/[id]/route.ts` PATCH already calls `fireDealerSync` (fire-and-
  forget, ~line 320) and `archiveCustomer` on deactivation (~lines 220/469).
- Reuse: `syncDealerCreateReliable` (retry 3× + Mandrill alert + read-back) is the
  reliability pattern; `archiveCustomer`/`unarchiveCustomer` in `lib/billing.ts`;
  `isPayingAccount` = normalized account_type ∉ {Free, Trial}.

## Part A — realtime + reliable `subscription_type` / `lifecyclestage`
Generalize the create-reliable variant into `syncDealerReliable(dealerId,
context)` (retry + alert + read-back); `syncDealerCreateReliable` becomes a thin
caller with `context="dealer create"`. In the dealer **PATCH** route, when the
update **changes `account_type`** or otherwise moves lifecycle (upgrade /
downgrade / pause), call `syncDealerReliable(...)` **instead of** the plain
`fireDealerSync`. Keep `fireDealerSync` for non-lifecycle edits (address, phone,
logo). Net: the two workflow-trigger fields always land promptly, with retry +
alert if HubSpot is flaky — same bar as Trial-create. ("On the click that changes
the plan → write to HubSpot," reliably.)

## Part B — "Downgraded" lifecycle (paying → Free)
1. **Migration** (next number): add `dealers.downgraded_at timestamptz` and
   `dealers.inactivated_at timestamptz` (both nullable). If DA already has a
   deactivation timestamp, reuse it instead of adding `inactivated_at`.
2. **Detect the transition** in the dealer PATCH route — compare prior vs new
   `account_type`: if `isPayingAccount(old)` && `normalizeSubscriptionType(new)
   === "Free"` → set `downgraded_at = now()`. On **re-upgrade** (old not-paying →
   new paying) → clear `downgraded_at`.
3. **Derive the stage** — pass `downgraded_at` into `dealerCompanyProperties`:
   - paying → `CUSTOMER` (and clear `downgraded_at` on this transition)
   - else `downgraded_at` set → `ACCOUNT_DOWNGRADED`
   - else (never-paid Free/Trial) → existing Trial / Trial-Expired logic
   So a Free-because-downgraded dealer reads **Downgraded**, while a never-paid
   Free/Trial dealer still reads Dealer Trial. This stage push rides Part A's
   reliable path.

## Part C — 60-day archive cron
New route `app/api/cron/archive-downgraded/route.ts` (POST, `x-cron-secret`,
return 200 immediately then run in background — mirror `purge-old-pdfs`):
- Select `dealers` WHERE `downgraded_at IS NOT NULL` AND `downgraded_at < now() -
  interval '60 days'` AND `active = true` (skip already-archived).
- Per dealer (idempotent, per-row try/catch):
  - **DA-Platform:** set the dealer **Inactive** (`active=false`,
    `inactivated_at=now()`) — DA's term for "archive" is **Inactive**; mirror the
    dealer route's existing deactivation path.
  - **da-billing:** `archiveCustomer(dealer.billing_customer_id)` (guard null).
  - Optional final HubSpot push (no "Archived" stage today — see confirm #4).
- Log + Mandrill summary (like the ETL / ChromeData crons). Register EasyCron
  daily (e.g. `0 6 * * *`) and add it to the deployed-cron list in
  CLAUDE-da-platform.md.

## Confirms for Alex/Allan (defaults chosen — flag if wrong)
1. ✅ **Resolved — DA-Platform "archive" = "Inactive" (`active=false`)**, per Allan
   2026-05-31 ("we call Archive 'Inactive'"). da-billing keeps its own term
   `archiveCustomer`.
2. **Downgrade target = `Free` only** (Allan said "to Free"; paying→Trial is
   treated as Trial, not Downgraded).
3. **Re-upgrade clears `downgraded_at`** → back to Customer (assumed yes).
4. **Archived dealers in HubSpot:** leave at Downgraded, or add an "Archived"
   lifecycle stage to push on archive?

## Verify
- Flip a paying dealer to Free → `downgraded_at` set; HubSpot `lifecyclestage` →
  Downgraded within seconds (reliable path); confirm Alex's workflow enrolls.
- Re-upgrade → `downgraded_at` cleared, stage → Customer.
- Back-date a `downgraded_at` >60d, run the cron → dealer set **Inactive** in DA +
  archived in da-billing; summary email lists it; re-run is a no-op.
- Bad token on a plan change → retry then Mandrill alert + `hubspot_sync_errors`
  row; app unaffected.
