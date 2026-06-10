# QA verification schedule — 2026-06 changes

> Owner: Allan. Created 2026-06-09. Work through on **prod**. Mark each ✅/❌ + note the date/who.
> Hand the lighter UI checks (fuel rule, invoice view, group-billed view, ?type) to Marlena;
> keep billing / print-lock / impersonation for you or Alex.

## Setup — accounts & safety
- **Mutating tests** (create product, print, change plan, downgrade) → do them on a **Test dealer**
  (`account_purpose='test'`, so it's excluded from BI/billing) so you never pollute a real dealer or
  trigger real billing. Read-only/role checks can use the real accounts below.
- Accounts you'll use: **super_admin** (you) · **Dealer General** (group; past-due; group-billed) ·
  **Mercedes Benz of Collierville** (DG member, group-billed, Automatic Web) · a **self-billed
  dealer** · a **trial dealer** (or create one).
- ⏳ Two areas are **not verifiable yet**: **#115 ETL enforcement** (blocked; Mercedes is on the
  `migrated` stopgap) and the **#116 session-layer rework** (built, held). Verify those once they ship.

---

## 0. Deploy mechanics (zero-downtime) — do first, it underpins all deploys
- [ ] da-platform cutover: 2 workers online, `/login` 200, `current/.next/BUILD_ID` = seeded release.
- [ ] Live `deploy.sh` of a trivial change + tight curl loop on `/login` → **zero non-200s**, new BUILD_ID live.
- [ ] `rollback.sh` → previous release in seconds, zero failures.
- [ ] Deliberately-broken build → `deploy.sh` **aborts, `current` unchanged** (old release still serving).
- [ ] (After da-platform proves out) repeat for **da-billing** (watch standalone+cluster; `instances:1` fallback ready).

## 1. 🔴 Billing price integrity (money — highest priority)
- [ ] **Dealer General template** shows canonical prices (Auto-Web $150 / Auto-DMS $200), 50% reseller discount → **$16,125** monthly (not $7,937).
- [ ] On a **test customer**, save a template line with a deliberately wrong price → da-billing **canonicalizes it** (the sent price is ignored).
- [ ] Rename a (test) dealer → **no price changes** on its template.
- [ ] Spot-check 2–3 of the re-canonicalized group/reseller templates → no legacy prices remain.
- [ ] da-billing **customer-detail Invoice History** for Dealer General shows **both** invoices (matches the Invoices tab + the platform).

## 2. Past-due print lock
- [ ] A **Dealer General member dealer** (group past due) → Print/Info/Guide **blocked**, tooltip = *"contact your Group Administrator"*; both **single and bulk**.
- [ ] A **self-billed past-due** dealer (if one exists / simulate on a test dealer) → tooltip = *"past-due invoice"*.
- [ ] A **current** (not-past-due) dealer → **prints fine** (the false-positive check — this is the one that matters most).
- [ ] **super_admin** → bypasses the lock.
- [ ] In da-billing, raise a locked customer's **Overdue Days** → the dealer's printing **unlocks within ~1 min** (cache TTL), no app restart.
- [ ] (If feasible) da-billing unreachable → printing **still works** (fail-open).

## 3. BI tab — `/admin/bi` (super_admin)
- [ ] Loads for **super_admin**; a group_admin/dealer gets **403 + no nav entry**.
- [ ] Default range = **last calendar month**; custom range works.
- [ ] Reconcile: **started = converted + lost + still-active**; **gross-billable matches** da-billing's MRR/Reports.
- [ ] **Download PDF** and **Download Excel** → both reconcile to the on-screen numbers.
- [ ] **Email report** → arrives at your inbox with **PDF + Excel** attached.
- [ ] **Test/demo dealers are excluded** from every metric (the flagged 16 don't appear).

## 4. Group-billed dealer Billing view
- [ ] As **Mercedes Benz of Collierville** → My Profile → Billing shows **"Automatic Web · Billed by Dealer General"**, with **no** Change Plan, **no** invoices, **no** Pay (no empty "No active subscription" state).
- [ ] As a **self-billed** dealer → still sees its **own** subscription + invoices + Pay (unchanged).

## 5. Invoice view/download (Billing tab)
- [ ] As a **self-billed dealer**, **group**, and **super_admin** → **View** opens the invoice; **Download** = a real `.pdf` (filename carries the invoice #), on **both outstanding and paid** rows.
- [ ] Requesting an invoice id that **isn't yours** → **403**.

## 6. Fuel Type product rule
- [ ] Configure Product → **Fuel** multiselect shows the curated list (Gasoline/Diesel/Hybrid/Plug-in/Electric/Flex/Hydrogen/CNG/Propane) + **IN/NOT IN**.
- [ ] **Fuel IN [Electric]** → applies only to EVs (catches BEV/ELEC); **NOT IN [Gasoline]** → excludes gas; **empty** → all.
- [ ] Holds in **both** the on-screen preview and the **printed** addendum.
- [ ] Existing products (no fuel rule) **unchanged**.

## 7. Account-purpose classifier
- [ ] Create a dealer as **Test** or **Sales Demo** → `is_test=true`, **excluded from BI**; as **Real** → included.
- [ ] Backfill check: the 8 demo accounts read `sales_demo`, the QA fixtures read `test`.

## 8. Impersonation security fix (#116)
- [ ] **super_admin → Groups → click a group name** → opens the **group profile as super_admin** (NOT auto-impersonated as "Crown Nissan / Robert Utchel").
- [ ] Impersonate / Ghost happens **only** via the explicit labeled button.
- [ ] ⏳ After the **session-layer rework** deploys: entering impersonation lands at **group level** (not inside a member dealer) and does **not** mutate the impersonated user's stored active dealer.

## 9. `?type` bulk-button fix
- [ ] **Bulk Infosheet** and **Bulk Buyer Guide** → the print/addendum screen opens the **correct doc type** (not defaulting to Addendum).

## 10. group_admin Dashboard/Products scoping
- [ ] A **group_admin switched into a member dealer** → Dashboard + Products show **that dealer's** data (not all dealers, not the group ghost).

## 11. ⏳ ETL config-lock (verify after #115 deploys)
- [ ] (Now: Mercedes on the `migrated` stopgap → ETL skips it; dupes deleted.) **After #115 ships + Dealer General `etl_locked=true`:** delete a Mercedes product → run `npm run run-now` → product **stays deleted** (Job 5 skipped); **print-status (Job 6) still syncs**.

## 12. Spot-check earlier-session items (lighter — confirm if not already)
- [ ] QR code prints on a **transparent** background (no white box). 
- [ ] Dealer **address edit** in My Profile saves + shows on the addendum.
- [ ] **MPG** widget shows City/Highway on the infosheet (where seeded).
- [ ] A new **standalone trial** lands with the **sample** product + 2 sample vehicles.
- [ ] **Single** Addendum + Infosheet print works (the CSP fix).

---

## Suggested sequence
1. **Cutover + §0** (you/Alex) — must pass before trusting any further deploy.
2. **§1 Billing + §2 Print lock** (you/Alex) — money + the dealer-facing gate; highest risk.
3. **§3 BI** (you) — reconcile the numbers.
4. **§4–§10** UI/feature checks (hand to Marlena on a **Test dealer** where mutating).
5. **§11 ETL + §8 session-rework** once those ship.
6. **§12** spot-checks as time allows.
