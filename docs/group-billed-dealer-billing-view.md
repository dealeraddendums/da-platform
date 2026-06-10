# Group-billed dealer — Billing tab shows plan + payer (not an empty state)

> For Claude Code. Owner: Allan. Created 2026-06-08. da-platform only; no migration; no writes.

## Bug
A **group-billed** dealer (`subscription_billed_to = 'group'`, e.g. **Mercedes Benz of Collierville**
in **Dealer General**) opens My Profile → Billing and sees **"No active subscription template" /
"No paid invoices yet."** Cause: `app/api/billing/me/route.ts` resolves the **dealer's own**
da-billing customer (`customerKey = billing_customer_id ?? internal_id`) and fetches *its*
template/invoices — but a group-billed dealer has no own customer; the subscription + invoices live
on the **group's** da-billing customer. The route never reads `subscription_billed_to` / `group_id`,
so it falls through to the empty state.

## Requirement (Allan)
A group-billed dealer **can't see or pay invoices** (the group pays), but **must see**:
1. **What subscription they have** (e.g. Automatic Web), and
2. **Who's paying** (their group — Dealer General).

## Fix
**`app/api/billing/me/route.ts`:**
- Also select `subscription_billed_to`, `group_id`, `account_type` on the dealer.
- **If `subscription_billed_to === 'group'`:** resolve the group name (`groups.name` via `group_id`)
  and return a group-billed payload — e.g. `{ billedBy: 'group', groupName, subscriptionTier:
  <account_type>, canManage: false }`. **Skip** the dealer's own `getTemplate` / `listInvoices`
  (there are none). Self/dealer-billed → **unchanged** (current behavior).

**`app/(dashboard)/profile/ProfileClient.tsx` (Billing section, ~1540–1801):**
- When `billedBy === 'group'`, render a **read-only summary** in place of the subscription/invoice
  cards: *"Subscription: {tier} · Billed by your group: {groupName}. Contact your group
  administrator for billing changes."*
- **Hide** the **Change Plan** button, the invoice/pay UI, and the "No active subscription template"
  / "No paid invoices yet" empty states for this case.

**Tier display:** use `dealer.account_type`, normalized to the friendly label
(`normalizeSubscriptionType` / the `SUBSCRIPTION_TIERS` names in `lib/billing.ts`) so it reads
"Automatic Web" — matching the Dealers-list Subscription column. (The group's da-billing template
has a per-dealer line — `lineItemDescription = "{internal_id}::{name}"` — if you want to cross-check
the exact billed tier; `account_type` is the platform source of truth and should match.)

**Discriminator:** key on `subscription_billed_to === 'group'`, **not** mere group membership — a
**self-billed dealer that happens to be in a group** keeps the normal dealer billing view (own
subscription + invoices). Same discriminator the past-due print lock uses.

## Optional enhancement (flag, don't over-build)
Surface the **group's billing health** here too — e.g. *"Your group has a past-due balance — printing
is paused; contact your group administrator."* — so a group-billed dealer understands a paused-print
state. It's the same `getBillingStatus(<group's customer>)` the print lock already reads. Nice-to-have.

## Consistency
`DealerBillingTab.tsx` (super_admin / dealer-detail / group_admin-switched-in view) already branches
on `subscription_billed_to` and hides invoices for the group case — confirm it also **shows the plan
+ "billed by {group}"** (not just an empty/“no invoice data” note); align it with the same summary so
both surfaces read the same.

## Verify
- As **Mercedes Benz of Collierville** (dealer_admin) → Billing shows **"Automatic Web · Billed by
  Dealer General"**, with **no** Change Plan, **no** invoices, **no** Pay, and none of the empty-state
  text.
- A **self-billed** dealer (in or out of a group) still sees its own subscription + invoices + Pay.
- A **super_admin's own** profile (no dealer) is unchanged (still "no subscription," correctly).
- STOP for review before deploy.
