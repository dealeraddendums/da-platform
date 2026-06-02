# Feature — dealer self-close (downgrade to Free / stop billing)

> For Claude Code. Owner: Allan. Updated 2026-06-01.
> Dealer-initiated "close my account" on My Profile → Billing. **Recurring billing
> stops immediately; the account stays in the 60-day Downgraded grace window and is
> archived by the existing cron only if they don't come back.** Reuses the
> Downgraded/archive pieces already built.

## Flow (per Allan)
Dealer downgrades to **Free** = closing the account:
1. **Balance gate — must be $0.** Outstanding (pending/overdue) invoices block the
   close; show them with Pay links. Only a $0 balance may close.
2. If $0:
   1. **Soft reason prompt** — why are they leaving (optional/skippable: preset
      reasons + free-text) → saved to `account_closures`.
   2. **Cancel recurring billing immediately**, set the account **Downgraded**
      (not archived yet).
   3. **HubSpot lifecycle update.**
3. **Archive happens at +60 days** via the existing cron — *not* now — so a dealer
   who changes their mind inside 60 days can re-open trivially.

## On confirm (the `POST /api/billing/me/close` endpoint)
- `requireAuth`; dealer_admin → own dealer only (super_admin allowed while
  ghosting); not dealer_user.
- **Re-check $0 server-side** (don't trust the client) against the same da-billing
  balance the BillingTab reads; reject if any pending/overdue invoice remains.
- **da-billing — stop recurring now:** cancel the subscription template so the
  daily invoice cron generates no further charges (e.g. `deleteTemplate(customerId)`
  / clear the subscription line — confirm the exact call that halts recurring
  invoices). **Do NOT `archiveCustomer` here** — that's the 60-day cron's job.
- **Platform — Downgraded, still active:** `account_type='Free'`, `downgraded_at =
  now()`, lifecyclestage → Downgraded. **Leave `active = true`** (no `archived_at`)
  so they remain usable/re-openable during the grace window.
- **HubSpot:** `syncDealerReliable(dealerId)` → `ACCOUNT_DOWNGRADED` (reliable path;
  firing the lifecycle update is the point).
- **Reason:** insert an `account_closures` row.
- Audit log: `account_closed`.

## Data — `account_closures` table (confirmed)
Migration (check max #): `account_closures (id, dealer_id, reason text, detail
text, closed_by, closed_at timestamptz default now())`. Gives Claire/marketing
churn-reason analytics.

## Archive at 60 days — reuse the existing cron (no new code)
`app/api/cron/archive-downgraded/route.ts` already archives `active = true`
dealers whose `downgraded_at` is >60 days old → sets Inactive (`active=false`,
`archived_at`) **and** `archiveCustomer` in da-billing. A self-closed dealer flows
straight into this: recurring billing already stopped at close, so no charges
accrue during the window, and the cron does the final archive only if they haven't
re-opened.

## Re-open within 60 days (easy path)
Because the account is only Downgraded (never archived) during the window,
re-opening = re-subscribe: pick a paid plan → recreate the da-billing template →
clear `downgraded_at`, lifecyclestage → Customer (active was always true). No
un-archive needed. (After the 60-day archive, re-opening is the separate
super-admin reactivation path — out of scope.)

## HubSpot stage
Reuse **Downgraded** for the close (and the 60-day archive leaves it at Downgraded
for now). If Alex later wants to distinguish "closed/churned" from a plain plan
downgrade, that's a separate added stage — not in this build.

## UI — BillingTab (`app/(dashboard)/profile/ProfileClient.tsx`)
**There is no downgrade/close entry point today** — the top-right "Cancel" button
is just the Change-Plan panel toggle (`setChangeOpen`; its label flips
"Change Plan" ↔ "Cancel", ~line 1507), NOT a cancel-subscription, and the plan
list (`SUBSCRIPTION_TIERS`, ~1540) only offers the 3 paid tiers. Add the path:
- Add a **"Free" option as the last item** in the plan picker, styled like the
  other tiers so it reads as a real choice, with a **plain-English description of
  what happens** right in the option (the dealer should understand before
  selecting, not just at the confirm). Suggested copy:
  > **Free — $0/mo**
  > Cancels your subscription and closes your account. Billing stops immediately.
  > You keep log-in access for 60 days (view only — no printing), then the account
  > is archived. Re-subscribe any time within 60 days to restore it. Requires a $0
  > balance.
- Selecting Free does **not** call `changeTier` (that PATCHes to a paid plan); it
  launches the close flow:
  - pre-check `outstandingAmount`: `> 0` → block ("Settle your balance ($X, N
    invoices) before closing," with Pay links, no close); `= 0` → reason modal
    (preset reasons + optional note) → "Close account" confirm that restates the
    above.

## Verify
- Outstanding-balance dealer (e.g. the $665 / 2-invoice test dealer) → **blocked**,
  pay-first message.
- $0 dealer → reason modal → confirm → da-billing recurring cancelled (no new
  invoices generate), platform shows Downgraded, **still active**, `account_closures`
  row written, HubSpot lifecyclestage = Downgraded.
- Re-subscribe inside 60 days → back to Customer, billing resumes, no archive needed.
- Leave a self-closed dealer >60 days → the cron flips it to Inactive + archives
  da-billing.
- Stop for review before deploy (touches billing + a migration).
