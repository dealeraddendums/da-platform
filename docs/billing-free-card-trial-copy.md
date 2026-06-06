# Fix — Billing "Free" card copy is wrong for Trial dealers (no subscription)

> For Claude Code. Owner: Allan. Created 2026-06-02.
> In the BillingTab plan picker, the bottom "Free" card always shows the self-close
> copy ("Cancels your subscription and closes your account…"). For a **Trial dealer
> with no active subscription**, that's nonsense — there's nothing to cancel. Make
> the card conditional: **Trial-progress** when there's no subscription; the existing
> **self-close** copy only when the dealer HAS an active subscription (downgrading).

## Where
`app/(dashboard)/profile/ProfileClient.tsx` — BillingTab plan picker, the bottom
"Free / close-account" card (~1612–1660). `isCurrentFree = !sub || sub.productId == null`
(true for a no-subscription / Trial dealer; the card is already `disabled` + marked
CURRENT in that case). The self-close copy is ~line 1654.

## Change — branch the bottom card on `isCurrentFree`
- **`isCurrentFree` (no subscription = Trial) — informational, header "Trial":**
  - Within allowance: "**Trial** — you're on day {trialDayN} of 30 and have printed
    {trialPrintN} of 30. When you reach either limit, you'll need to upgrade to keep
    printing." (no close action — stays disabled/CURRENT.)
  - Over allowance (Trial Expired): "**Trial ended** — you've reached the 30-day or
    30-print limit. Upgrade to keep printing."
- **`!isCurrentFree` (active subscription → downgrading) — header "Free":** keep the
  existing copy ("Cancels your subscription and closes your account… 60 days… $0
  balance.") + the close-account action. This is the only case that copy is correct.

(Renaming the header **Trial vs Free** by the same condition removes the Trial/Free
conflation — a Trial dealer isn't on the "Free" plan.)

## Data — surface trial status to the tab
The tab needs `created_at` + a lifetime print count. Add to the BillingTab's data
source (`/api/billing/me` or the profile page's server props):
- `trialDayN` = `clamp(floor((Date.now() − created_at) / 86_400_000) + 1, 1, 30)`
- `trialPrintN` = dealer lifetime print count (`print_history`, same as `canPrintForDealer`)
- `overAllowance` = reuse `isOverAllowance({ created_at, lifetime_prints })` from
  `lib/print-eligibility.ts`; caps `TRIAL_DAYS_CAP` / `TRIAL_PRINTS_CAP` (30/30) from there.
Use those constants — don't hardcode 30.

## Verify
- Trial dealer (no subscription) → bottom card reads "Trial — day X of 30 · Y of 30
  prints, upgrade at the limit" (not "cancels your subscription"); still shows as
  current + not clickable.
- Trial past 30 days or 30 prints → "Trial ended — upgrade to keep printing."
- Paid dealer → bottom card still shows the self-close copy + works as the downgrade.
- Stop for review before deploy.
