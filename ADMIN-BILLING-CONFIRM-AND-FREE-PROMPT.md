# Admin Dealer Billing — Conversion Confirm + Free Option — CC Prompt (round 2)

> Ready-to-hand-to-Claude-Code prompt. Authored 2026-06-17.
> Follow-up to the admin Dealer -> Billing subscription-parity tab. Two additions, both
> reusing existing endpoints — no new billing write logic.

---

TASK (follow-up to the admin Dealer -> Billing subscription tab): two additions to
components/DealerBillingTab.tsx, both reusing existing endpoints — no new billing write logic.

PART A — conversion confirm on the plan picker:
When picking a plan would CONVERT a non-paying dealer to paid, show a confirm before the PATCH.
Client signal: the dealer has no active paid subscription (the GET's subscription is null) — that's
the conversion case. Confirm copy: "This will convert {dealer name} to a paying {tier name} plan and
start billing on the 1st of next month. Continue?" On cancel, do nothing. On confirm, fire the
existing PATCH /api/billing/me/subscription?dealer_id=<TEXT dealer_id> { tier }.
Do NOT confirm when subscription is already set (a plain tier swap of an already-paying dealer) —
that stays one-click like the dealer side.

PART B — add a "Downgrade to Free / Close account" action:
Reuse the existing endpoint POST /api/billing/me/close?dealer_id=<TEXT dealer_id> (it already allows
super_admin via ?dealer_id= and in-group group_admin; same pattern as the subscription PATCH). Do
NOT write new cancel logic. Mirror ProfileClient's close flow (~lines 1462-1471: closeStep
"reason"/"closing", closeReason/closeDetail, closeAccount()) — a reason step that doubles as the
confirm, then POST.
- Show this action ONLY when the dealer is currently on a paid plan (subscription present / paid
  account_type). Hide it for Trial/Free dealers (nothing to downgrade) and for group-billed dealers
  (that branch returns earlier — no close here).
- Gate on canManageBilling (same as the rest of the tab).
- Handle the endpoint's 409 outstanding-balance response: show its pay-first message with the
  outstanding amount + invoice count (don't downgrade until balance is $0) — same as the dealer side.
- On success: the endpoint sets account_type=Free + downgraded_at, deletes the da-billing template
  (stops recurring billing immediately; the +60-day cron archives later), pushes HubSpot
  lifecyclestage=Downgraded, and keeps log-in during the 60-day grace. refresh() + toast
  ("✓ Downgraded to Free. Recurring billing cancelled; log-in continues for 60 days.").
  Re-subscribing later is just the plan picker again (creates a new template, lifecycle -> Customer).

VERIFY BEFORE DEPLOY:
- Conversion confirm fires only when subscription is null (Trial/Free setup); a tier swap of an
  already-paying dealer does NOT prompt.
- No price is ever sent (PATCH body is { tier } only).
- Downgrade-to-Free reuses /api/billing/me/close (no new cancel logic), uses the TEXT dealer_id,
  is hidden for Trial/Free + group-billed dealers, blocks on an outstanding balance (409), and on
  success shows Free + cancels recurring billing.
- group-billed dealer: still unchanged (no Change Plan, no Close).
- tsc + next build clean.
- STOP and show me the tab (conversion-confirm dialog + the Free/close flow, has-customer +
  no-customer states) + the diff before deploying (billing-sensitive).
