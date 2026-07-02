# Bug — trial→paid upgrade doesn't fully convert a migrated/legacy dealer

> For Claude Code. Owner: Allan. Created 2026-06-10. **Billing-sensitive — STOP for review before
> deploy.** da-platform.

## Symptom
**AutoNation BMW of Houston North** (an expired trial) was upgraded, but: the **"Upgrade Now"** CTA
still shows, **printing is still locked**, and **no da-billing customer was created**. My Profile →
Billing shows "Monthly Subscription Automatic Web $150.00/month, Next Invoice Jun 10" but "No paid
invoices yet," and da-billing Customers has no record for it.

## Root cause (`app/api/billing/me/subscription/route.ts`)
`isConversion = !dealer.billing_customer_id && dealer.legacy_id == null`. The **full conversion**
(create da-billing customer + **flip `account_type` to the paid tier + clear the trial lifecycle** +
HubSpot Trial→Customer) runs **only when `isConversion` is true**. A **migrated/legacy dealer
(`legacy_id` set)** falls into "Case 2 — legacy dealer; FreshBooks customer keyed by `internal_id`;
don't recreate," which does a `putTemplate` (→ the Billing tab shows the plan) but **creates no
da-billing customer and never flips `account_type`**. So the dealer stays `account_type` = Trial →
print gate `trial_expired` (locked) + the trial-only "Upgrade Now" CTA persists, and da-billing has
no customer. The FreshBooks assumption is stale: on the new platform, migrated dealers bill via
**da-billing** (FreshBooks suspended at cutover), so they need a da-billing customer just like a
native dealer.

## Verify the dealer's state first (read-only, confirms the diagnosis)
For AutoNation: `account_type` (expect still Trial/null), `legacy_id` (expect set — the trigger),
`billing_customer_id` (expect null), `downgraded_at`, and whether an orphan template exists for its
`internal_id` in da-billing.

## Fix
1. **Ensure a da-billing customer on ANY trial→paid upgrade with none — regardless of `legacy_id`.**
   Replace the `legacy_id`-based skip: if there's no `billing_customer_id`, **link-or-create** the
   da-billing customer (use the existing create-or-link guard — link if one resolves by `billing_id`,
   else create; **never duplicate**), then persist `billing_customer_id` + `template_id`. Drop the
   "FreshBooks customer keyed by internal_id, don't recreate" path for new-platform billing.
2. **Always flip `account_type` to the paid tier + clear the trial-expired / downgraded lifecycle**
   on a successful subscription set — move this OUT of the narrow `isConversion` branch so it runs
   for migrated dealers too. This unblocks the print gate, removes the "Upgrade Now" CTA, and fires
   HubSpot Trial→Customer.
3. Keep "no price sent — da-billing prices it" (billing price-integrity) intact.

## Remediate AutoNation (live dealer, currently stuck)
Create/link its da-billing customer + template, set `account_type` = `Automatic Web`, clear the
trial/downgraded state → confirm it can print, the Billing tab shows a real customer (+ next
invoice), and "Upgrade Now" is gone. (One active dealer, so no fleet impact — but it's live.)

## Verify
- A fresh expired-trial upgrade on **both** a native dealer **and** a migrated dealer (legacy_id
  set) → `account_type` flips to paid, **print unlocks**, **"Upgrade Now" disappears**, a da-billing
  **customer + template exist (not duplicated)**, HubSpot moves Trial→Customer.
- AutoNation specifically: print works, billing shows its customer, Upgrade Now gone.
- STOP for review before deploy (touches billing + the print gate).

## Update 2026-06-10 — SHIPPED (`b945cf3`) + a follow-up gap found
Core fix deployed + verified on test dealers: native non-paying → CREATE + flip; re-run → no
duplicate; migrated-with-billing_id → LINK (not duplicate). Clean dealers convert correctly.

**Gap (task #125): legacy `internal_id`-keyed orphan templates block the upgrade.** Some migrated
dealers carry a template keyed by their `internal_id` with **no customer** (`GET /customers/{id}` =
404) — dead data the OLD Case-2 `putTemplate(internal_id)` path left behind. On upgrade, the new
code creates a real customer, then `createTemplate` is rejected by da-billing's duplicate-dealer
guard ("Dealer already on a template for {internal_id}") → 500 + a **dangling created customer**.
Reproduced + cleanly reverted on **AutoNation** (its `1777925013` orphan template is the example;
its Supabase row is back to `Free`, pointers null).

**Fast-follow fix:**
1. **Size it (read-only):** count/list dealers with an orphan `internal_id` template (template
   exists, customer 404).
2. **On provision:** if the dealer has an orphan `internal_id` template, **delete it first** (it has
   no customer → can't bill → safe) to release the assignment, then create the real customer +
   attach the template to it.
3. **Defensive (regardless of cause):** if `createTemplate` fails, **archive/delete the
   just-created customer and don't persist `billing_customer_id`** — never leave a dangling customer.
4. **AutoNation remediation** runs after this ships (one auto-web upgrade self-remediates).
5. Optional: a one-time **sweep** to delete all orphan templates (dead data) if the count is
   non-trivial.

**Disposition:** keep `b945cf3` live (it fixes the common case); don't upgrade orphan-template
dealers until the fast-follow ships.
