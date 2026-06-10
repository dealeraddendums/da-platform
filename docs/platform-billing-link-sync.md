# Fix — platform ↔ da-billing customer-link sync (`billing_customer_id` backfill)

> For Claude Code. Owner: Allan. Created 2026-06-06. **Supersedes the earlier "Step 3 =
> create 128 group customers" framing** — the customers already exist; the *link* wasn't
> backfilled. Cross-system (DA Platform + da-billing). Read-only audit + dry-run first.

## Symptom
DA Platform group page (Dealer General) → **Billing** tab shows *"Billing account not set up —
this group does not have a da-billing customer record yet"* with a **Create Billing Account**
form. But **da-billing already has** Dealer General as an **active** customer: Customer ID
`18796f8c-c`, DA Client ID `297`, 50% subscription discount, active recurring template (next
invoice Jun 12 2026, 214 dealers). So the platform's `groups.billing_customer_id` is empty even
though the da-billing customer exists and is billing.

## Corrected understanding
These accounts were migrated from FreshBooks, so the da-billing customers **already exist**. The
platform's `billing_customer_id` link was **never backfilled** — *that's* the gap, not a missing
customer. Per Allan: **~95% of accounts should already have a da-billing customer; only accounts
created in the last ~60 days may not.** So this is a **sync/backfill, NOT a mass-create.**
Mass-creating would **duplicate** every existing da-billing customer.

## ⚠️ Live risk — guard "Create Billing Account" first
The Billing tab's **Create Billing Account** button (and the lazy create-on-next-event path in
`lib/group-billing-cascade.ts`) will create a **second** da-billing customer for an entity that
already has one. **Until the guard ships, don't click it on an existing account.** Fix: before
creating, look up da-billing for an existing customer for this entity (match key below); if
found, **link it** (`billing_customer_id = existing.id`) instead of creating.

## The matching key (the crux — resolve against live data)
The platform→da-billing create payload (`BillingCustomerInput`) carries **no platform id** (only
`name`/`company`/`email`/`address`/`phone`/`state`), and `lib/billing.ts` exposes **no
list/search** — only `createCustomer` + `getCustomer(id)`. So the link must be reconstructed.
da-billing tracks a **"DA Client ID"** (Dealer General = `297`) — the strongest candidate: it
likely maps to the platform's **legacy/Aurora id** (`internal_id` / legacy group/dealer id),
since these are FreshBooks-migrated. **CC: determine the reliable match key from the live
da-billing store** (DA Client ID ↔ platform legacy/internal id, with email/company as fallback)
and **report the match rate per key** before backfilling.

## Plan
1. **Read-only audit (all groups + dealers).** Enumerate da-billing customers — query da-billing's
   own Supabase store / Customers data directly, or add a `listCustomers` / `findCustomerByClientId`
   endpoint (none exists today) — and match to platform groups/dealers. Categorize each:
   - **synced** — platform `billing_customer_id` set and matches a da-billing customer;
   - **link-missing** — da-billing has a customer, platform `billing_customer_id` null → backfill;
   - **genuinely-new** — no da-billing customer (expect ~last-60-day accounts);
   - **mismatch / orphan** — platform id points to nothing, or a da-billing customer with no
     platform match.
   Report counts + a CSV (entity, platform id, da-billing id, DA Client ID, category).
2. **Backfill** `groups.billing_customer_id` / `dealers.billing_customer_id` from the matched
   da-billing customer id for the **link-missing** set. Idempotent; **dry-run first**, review, then write.
3. **Guard create** — `Create Billing Account` + the cascade's lazy create must check da-billing
   for an existing customer (match key) and **link** instead of duplicating.
4. **Genuinely-new** accounts (recent, no da-billing customer) are the only ones that should
   create — and only via the guarded path.

## Verify
- Dealer General's Billing tab shows the **existing** customer (`18796f8c-c`), not "not set up."
- Audit: ~95% resolve as synced or link-missing→backfilled; only recent accounts flagged
  genuinely-new; **zero duplicate da-billing customers created.**
- "Create Billing Account" on an account that already has a customer **links** it (no duplicate).
- Read-only audit + dry-run **first**; STOP for review before the backfill writes and before any
  guard-create deploy.
