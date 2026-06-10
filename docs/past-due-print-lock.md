# Past-due print lock + da-billing invoice-history bug

> For Claude Code. Owner: Allan. Created 2026-06-07. Spans **da-platform** (the print gate) and
> **da-billing** (the past-due source + a detail-page bug).

## 1. Past-due print lock (the feature)
**Rule:** a dealer is **blocked from printing** when **it OR its group is past due** on payments.
"Past due" is determined by da-billing using the customer's **Overdue Days** grace period — the
field on each da-billing customer (default **37**; some groups 45/60; **Dealer General = 10**).
An invoice is past due when it's unpaid and older than `issue_date + Overdue Days`. Example:
Dealer General (group-billed, 2 overdue invoices, 10-day grace) → **all 196 member dealers
locked** until the balance clears.

### Source of past-due truth (da-billing — already reachable)
da-platform's Billing tab already pulls the customer's outstanding/overdue invoices from
da-billing via `lib/billing.ts`, so the path works. Add/extend a **billing-status** read, e.g.
`GET /customers/{id}/billing-status` → `{ past_due, outstanding_balance, oldest_overdue_date,
overdue_days }`, with da-billing computing `past_due` against the per-customer Overdue Days.
(Don't rely on the da-billing customer-detail invoice query — see bug #2, which under-counts.)

### Print gate (da-platform — `lib/print-eligibility.ts`)
- Extend `canPrint`/`enforceCanPrint` to also block on **past due**, stacking with the existing
  Trial/Free gates (any blocking reason blocks).
- **Resolve the responsible billing customer:** group-billed dealer (`subscription_billed_to =
  'group'`) → the **group's** da-billing customer; self/dealer-billed → the **dealer's own**.
  Check that customer's `past_due`.
- **Decision (Allan, locked 2026-06-07): responsible payer is the gate.** A **self-billed
  dealer is NOT locked** because its group is separately past due — it's gated only on its own
  account. A group-billed dealer is gated on the group's. Do not gate a self-billed dealer on
  the group's status.
- **Cache** the status (short TTL, ~15–30 min) so it's not a per-print round-trip.
- **Fail open:** if da-billing is unreachable / status unknown, **allow** printing — never block
  a paying dealer because the billing service hiccuped. Block only on a **confirmed** past_due.
- **super_admin bypasses** (consistent with the other gates).
- Enforce in all four print routes (`pdf/generate`, `pdf/bulk`, `print/bulk`,
  `print/[vehicleId]`) and disable the Print/Info/Guide buttons + tooltip in the inventory UI,
  mirroring the trial-expired pattern.
- **Message varies by responsible payer (Allan, 2026-06-07)** — key off the SAME discriminator
  the lock uses (`subscription_billed_to === 'group'`), NOT "is in a group." A dealer that's in a
  group but self-billed gets the self-billed message because they can act on it.
  - **Group-billed** (past-due is the group's; dealer can't fix it): *"Printing is paused. To
    restore it, please contact your Group Administrator."*
  - **Self-billed** (own past-due invoice; dealer can act): *"Printing is temporarily disabled
    due to a past-due invoice."*
  - Carry the variant on the gate result (e.g. a `billedBy: 'group' | 'self'` flag or reuse
    `subscription_billed_to`) so the UI renders the right text; show it as the **tooltip on the
    disabled Print button** (and the disabled Info/Guide buttons) so a dealer hovering learns why.
  - Optional: if the **viewer is a group_admin** switched into a group-billed locked dealer (they
    *are* the administrator + can manage group billing), show an actionable variant instead — e.g.
    *"Printing is paused — the group has a past-due balance. Settle it in Billing to resume."*
    Minor; skip if it complicates the gate.

## 2. Bug — da-billing customer-detail shows "Invoice History (0)" but invoices exist
On Dealer General's da-billing customer page, **Invoice History = 0**, yet the **Invoices tab**
(search by Company "Dealer General") shows **2**, and da-platform's Billing tab shows the same 2
(Outstanding $21,612.50, both OVERDUE). So the customer-detail invoice query uses a **mismatched
key** vs the search/API. Fix the detail page's invoice→customer lookup so it returns the
customer's invoices consistently (whatever key the working search/da-platform path uses — likely
the customer id `18796f8c-c` vs a name/company reference mismatch). This is a **da-billing**
fix; it doesn't block #1 (the gate uses the working API path), but the inconsistency should be
resolved so the detail page and the billing-status endpoint agree.

## 3. Fold-in — malformed-HTML sanitize on render (the garble cause)
Allan confirmed the earlier garbled template was a **malformed `<b>` tag (`<?b>`)** in content.
The corrupt-template **render guard** (already in progress) must therefore **sanitize/repair
malformed HTML** in template content (product names, descriptions, custom text) — not just clamp
widget geometry — so a stray bad tag degrades gracefully instead of garbling the whole layout.

## 4. Follow-up (2026-06-07) — cache staleness holds a stale lock/unlock
**Symptom (Allan):** changed Dealer General's Overdue Days 10 → 100 in da-billing (no longer past
due) but its dealers stayed print-locked. **Cause:** da-platform's **20-min in-memory
billing-status cache** still serves the old `past_due:true`; a da-billing edit doesn't reach into
da-platform to invalidate it, so the unlock waits out the TTL.

**Why not push an invalidation from da-billing:** the cache is **in-memory per PM2 process** (and
da-platform runs behind the ALB, possibly multiple workers), so a webhook would have to fan out to
every worker — fragile. A short TTL sidesteps the whole problem.

**Fix — shorten the TTL so grace/payment changes propagate fast:**
- Simple: drop the TTL to **~60s**. Still collapses a bulk print run's repeated checks into one
  da-billing call, but an unlock (or a new lock) takes effect within a minute, not 20.
- Better (optional): **asymmetric** — cache `allowed`/not-past-due ~15 min (the 99% healthy case,
  keeps round-trips low) but cache `blocked`/past-due **~60s** so a lock **releases promptly** when
  the operator fixes grace or the dealer pays. Locking fast doesn't matter; **unlocking** fast does.
- Don't persist `past_due` anywhere in da-platform — always derive from da-billing so there's one
  source of truth. Cache is read-through only.

**Verify the follow-up:** flip Overdue Days down (lock) then back up (unlock) → the dealers' print
state follows within ~1 min without a da-platform restart.

## Verify
- Dealer General (group past due, 10-day grace) → every member dealer is print-locked (single +
  bulk) with the past-due message; super_admin bypasses; a current dealer prints normally.
- Clear/pay the balance (or no overdue) → printing resumes.
- da-billing **down** → printing still works (fail-open).
- da-billing customer-detail Invoice History shows the correct invoices (#2 fixed).
- A template with a malformed tag renders cleanly (#3).
- Stop for review before deploy (print gate + billing).
