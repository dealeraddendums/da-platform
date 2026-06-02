# Feature — print-eligibility gate

> For Claude Code. Owner: Allan. Updated 2026-06-01.
> Trial accounts may print within their allowance; past it (and for any Free /
> downgraded account) they can still log in but cannot print. Net-new enforcement.

## Account-state model (clarified)
- **Trial** = how most dealers start. Allowance: **30 days OR 30 prints**,
  whichever comes first — **lifetime prints** (`dealers.lifetime_prints`), age
  **since account creation** (`dealers.created_at`). Within → can print (Dealer
  Trial); over → **Trial Expired** (log in, no print).
- **Paid** (Manual / Auto-Web / Auto-DMS / PAYGo — upgraded from trial) → always
  prints.
- **Free** is **never a starting state** — a dealer only *becomes* Free by
  **downgrading** from a paid plan (the self-close / downgrade flow). So a Free
  account is a former-paying, established account that is already well past the
  30/30 allowance → **it cannot print.** It can log in during the 60-day grace,
  then the archive cron deactivates it. Its lifecyclestage is **Downgraded**.

Upshot: **only paid accounts and within-allowance trials can print.** Everything
else (Trial Expired, Free/Downgraded) is log-in-but-no-print.

## Part A — `canPrint()` gate (net-new)
Today nothing gates printing on account status (only Order Labels checks
Free/Trial), so this is new enforcement.
- Shared helper `lib/print-eligibility.ts`:
  ```ts
  canPrint(dealer): boolean
    if isPaidDealer(dealer.account_type) return true              // reuse dashboard helper
    if isTrial(dealer.account_type) {                             // Trial allowance
      const ageDays = (now - dealer.created_at) / 1d
      return ageDays <= 30 && (dealer.lifetime_prints ?? 0) <= 30
    }
    return false                                                  // Free / downgraded / expired
  ```
- **Server-side enforce** (403 "Your {trial} limit is reached — upgrade to keep
  printing"): `app/api/pdf/generate/route.ts`, `app/api/pdf/bulk/route.ts`,
  `app/api/print/[vehicleId]/route.ts`, `app/api/print/bulk/route.ts`.
- **UI** — disable + explain (not hide): per-vehicle Print Now and the dashboard
  bulk bar (Print Now / Info Sheet / Buyer Guide) render disabled with an upgrade
  tooltip when `!canPrint`. Login, browsing, Builder, settings stay available.

## Part B — lifecycle (extends the realtime/Downgraded sync; no new stage needed)
With Free ⟺ Downgraded, the existing stages cover it — derivation in
`dealerCompanyProperties` (`lib/sync-hubspot.ts`), precedence:
1. paid → `CUSTOMER`
2. Free / `downgraded_at` set → `ACCOUNT_DOWNGRADED`
3. Trial over allowance (age > 30d OR lifetime_prints > 30) → `TRIAL_EXPIRED`
4. Trial within allowance → `DEALER_TRIAL`
Factor "over allowance" into one shared predicate that both `canPrint` and the
derivation use. The daily cron already re-evaluates Trial → Trial Expired — keep
that.

## Confirm (one open choice)
Do you want a **distinct "Free Expired" HubSpot stage**, or is **Downgraded**
enough for every Free account? Since Free only ever comes from a downgrade, the
two describe the same accounts — **recommend folding into Downgraded** (no new
stage, simpler). If marketing wants to distinguish "recently downgraded" from
"long-since-free," that's a separate stage + a date rule — say so and I'll add it.

## Verify
- Trial dealer prints up to 30 / within 30 days → works; the 31st print (or day
  31) → blocked in the UI and 403 server-side; can still log in.
- Downgraded ex-customer → cannot print, can log in during the 60-day grace.
- Paid dealer → unaffected.
- HubSpot: aged-out trial → Trial Expired; downgraded → Downgraded; fresh trial →
  Dealer Trial.
- Stop for review before deploy (print routes + the lifecycle predicate).
