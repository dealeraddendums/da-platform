# QA verification schedule — 2026-06-18 (supersedes 2026-06-09)

> Owner: Allan. Created 2026-06-18. Work through on **prod**. Mark each ✅/❌ + note the date/who.
> **Supersedes `qa-verification-2026-06-09.md`.** The 6/9 §0–§14 baseline still applies — finish any
> unchecked items there first. The three items 6/9 left **⏳-blocked have since shipped** and are
> promoted to active checks here (§A). Everything new since 6/9 follows.
> **Scope:** DA Platform + da-billing. (marketing-OS — two-way chat, funnel/leads, Mandrill — is
> tracked separately on the marketing side.)
>
> 🔴 = money/lifecycle, highest priority · ⏳ = not live yet, verify after deploy.

## Setup — accounts & safety
- **Mutating tests** (create product, print, change plan, downgrade, convert, migrate) → run on a
  **Test dealer** (`account_purpose='test'`, excluded from BI/billing/HubSpot) so you never pollute a
  real dealer or fire real billing. Role/read-only checks can use real accounts.
- Accounts: **super_admin** (you) · **Dealer General** (group; past-due; group-billed) · a **DG member**
  (e.g. Mercedes Benz of Collierville — group-billed, Automatic Web) · a **self-billed** dealer · a
  **trial** dealer · a **migration-eligible Test dealer** (set its contact email to one you control so
  the invite code comes to you — see the migration runbook's dry-run tip).
- ⚠️ **§O is NOT live yet** — verify after it deploys. **§N shipped 2026-06-18 (commit `46fc316`) —
  run it now.** **§B (migration) is billing-sensitive and `MIGRATION_AUTO_ACTIVATE` is OFF** (a
  migrated dealer is un-billed until an operator activates).

---

## A. Promoted from 6/9 (now shipped — were ⏳ then)

### A1. 🔴 ETL config-lock enforcement (#115)
- [ ] With **Dealer General `etl_locked=true`**: delete a member-dealer product → run `npm run run-now`
  on the ETL box → the product **stays deleted** (Job 5 Options skipped for locked dealers).
- [ ] Same run: **print-status (Job 6) still syncs** for that dealer (lock doesn't freeze prints).
- [ ] A **non-locked** dealer still syncs normally (false-positive check).
- [ ] (Reality check) the previously-duplicated Mercedes "Elite Member" no longer re-appears / no longer
  prints twice.

### A2. Impersonation session-layer fix (#116)
- [ ] **super_admin → Groups → click a group name** opens the **group profile as super_admin** (NOT
  auto-impersonated as a member user).
- [ ] Entering impersonation lands at **group level** (not inside a member dealer) and does **not**
  mutate the impersonated user's stored active dealer (no stale dealer/user leaks after exit).
- [ ] Impersonate / Ghost happen **only** via the explicit labeled buttons.

### A3. Builder QA (`builder-qa-2026-06-11`)
- [ ] **Dealer Address** box is read-only (source-of-truth from the profile) with an "edit in My
  Profile" hint; editing the profile changes what the widget shows; a **group** template shows each
  dealer's own address; alignment/font/position still editable.
- [ ] **No stuck widget:** a click **selects** without the widget following the cursor; a drag moves it
  and **releases on every mouseup** (incl. off the paper/window); a plain click never moves it.
- [ ] **Greyed-out (placed) palette tile** → clicking it **selects** the placed widget on canvas; still
  can't add a duplicate; multi-instance tiles unchanged.

---

## B. 🔴 Phase 13 — Self-serve migration (13a–13d) — billing-sensitive
> Driven from **Admin → Migration**. Full SOP in `single-dealer-migration-runbook.md`. Do the whole
> pass on a **Test dealer** you control end-to-end. `MIGRATION_AUTO_ACTIVATE` is **OFF** (review-queue).

### B1. Readiness console (Admin → Migration)
- [ ] Loads for **super_admin**; group_admin/dealer get no entry.
- [ ] Per-dealer row shows: ETL ✓/✗ · billing-template ✓/✗ · template-confirmed ✓/✗ · **Ready?** ·
  invite status. Filters (ready-only, group, state, search) work.
- [ ] **HARD gates block Ready:** billing-template-staged (paused, future `nextInvoiceDate`),
  template-confirmed, eligible (not white-glove: **Dealer General, Avia, Ourisman, Lithia**).
- [ ] **WARNINGS don't block Ready:** missing logo / dealer_settings / zero inventory show as warnings,
  not blockers.
- [ ] **Toggle template-confirmed** persists.

### B2. Invite + `/migrate` flow (13a)
- [ ] Select a Ready test dealer → **Send wave → preview → confirm** → recipient gets the **8-digit code**
  + an **inert** `/migrate` link; `migration_status → invited`; the wave is logged.
- [ ] `/migrate`: wrong/expired code rejected; correct code → confirm dealership → set up 5.0 login
  (passkey **or** password; passkey skippable) → review plan & billing → **Confirm**.
- [ ] Scanner-proof: loading the link / a HEAD on it does **not** consume the invite (only code or
  password submit does).

### B3. Confirm system actions (the event fan-out)
- [ ] On Confirm: `migration_status='migrated'`; `account_type` → correct **Paid** tier + `converted_at`.
- [ ] **da-billing:** the template flips **active with a FUTURE `nextInvoiceDate`** — **no immediate
  invoice**; **prices untouched** (group-billed → the group's customer). ← the no-double-bill guard.
- [ ] **HubSpot** lifecycle Trial → Customer + the dealer's user contact(s) sync.
- [ ] **FreshBooks stop = operator-queued Mandrill alert** fires (never auto-run — see §M5).
- [ ] **Marketing conversion webhook** fires (receipt verified on the marketing side).
- [ ] Invite consumed; re-using the code fails.

### B4. Review-queue / activate-billing (AUTO_ACTIVATE OFF)
- [ ] A migrated dealer shows **"Migrated · billing pending"**; it is **un-billed** until an operator acts.
- [ ] Operator **Activate billing** → flips the da-billing template active (future date intact, **prices
  untouched**); the dealer now bills on the pre-set date.

### B5. Rollback
- [ ] Console rollback (or `POST /api/migration/rollback`, super_admin) → `migration_status` back to
  **invited** + template `active=false`; **prices never touched**; re-runnable.

### B6. Assignment layer + eligibility
- [ ] Operators can claim ~25 dealers each; assignment shows who owns which.
- [ ] White-glove groups (**Dealer General, Avia, Ourisman, Lithia**) are **not** Ready / not self-serve.

---

## C. Group-discount auto-tiers + resync
- [ ] Tiers by **active member-dealer count**: **1/empty → 0% · 2–10 → 20% · 11–30 → 25% · 31+ → 30%**.
- [ ] On a **test group**, cross a boundary (add/remove members) → the discount **auto-updates** on the
  group's da-billing customer (`subscriptionDiscount`).
- [ ] **Locked (`discountLocked`) + non-tier custom values (e.g. 17%, 50%) are preserved** — not
  overwritten by the auto-tier.
- [ ] Spot-check 2–3 of the **147 resynced** groups → correct tier, no clobbered custom/locked values.
- [ ] **Dual-guard sanity:** a group sitting at **25%** still bills 25% (the tier value exists in BOTH
  platform `AUTO_TIER_VALUES` and da-billing `AUTO_TIER_DISCOUNTS` = {0,10,20,25,30}).

## D. Tax on LABEL items only + Tax tab + nav
- [ ] On a **test invoice** with mixed lines: tax is computed on **label line items only** (net of any
  label discount) — **subscription / color-photo / one-time lines are not taxed**, and the
  **subscription discount does not shrink the label tax base**.
- [ ] Tax only applies in **`taxableStates`** (nexus list) — a non-nexus-state dealer gets **$0 tax**.
- [ ] Same rule holds in **both** recurring-generation paths and the two dialog previews (create + edit).
- [ ] **Settings → Tax tab** renders and saves the nexus-state list (previously unrendered).
- [ ] Admin nav goes straight to **Settings** (no Admin → Settings detour).

## E. The 5 QA-walkthrough fixes
- [ ] **HubSpot Type = Industry on create:** a new dealer Company = `Automotive Dealer`; a new group =
  `Automotive Dealer Group` (Type matches Industry).
- [ ] **SuperAdmin create emails the user:** creating a dealer/group user sends the invite email (dealer
  + group fallback to the login email) — not silent.
- [ ] **Password show/hide** toggle on Add **and** Edit User.
- [ ] **Duplicate user email** → clean **409**, and **nothing is created** (no half-made user).
- [ ] **Group rename** → the name updates on the **da-billing** customer (company) too.

## F. Builder ↔ PDF positioning
- [ ] A template whose **Dealer Asking Price** sits where you placed it in the Builder **prints in the
  same spot** (no longer too high) — the askbar/suggested_price `line-height` fix.
- [ ] **Templates render at the correct paper size** (the `wide` paper no longer missing) — what you see
  in the Builder canvas matches the PDF.

## G. Group-badge / group-derived state
- [ ] A dealer **removed from its group** no longer shows the **"🔒 Group"** badge (gated on
  `group_controls_templates && group_id`).
- [ ] Removing a dealer from a group **reverts its billing-to back to `dealer`**.
- [ ] A genuinely group-controlled dealer **still** shows the badge.

## H. Spaces product-rule fix
- [ ] A **newly created** product rule defaults **Spaces = 0** (not 2).
- [ ] Existing rules read **0** (the 12,448-row backfill) — spot-check a couple of dealers' products.
- [ ] Run the ETL (`npm run run-now`) → synced options come in at **Spaces = 0** (the ETL no longer
  writes 2; the on-box fix holds).
- [ ] A printed addendum reflects 0 spaces where it used to insert 2.

## I. Smaller widget / UX ships
- [ ] **Asking Price symbol:** the optional symbol-after-price renders (e.g. `$39,999*`) when set, absent
  when not.
- [ ] **Per-vehicle product edit** on Addendum Details works (UI-only; doesn't change the saved template).
- [ ] **Product descriptions keep bullets/lists** (no longer stripped) on screen + printed.
- [ ] **Header-bar color palette** includes **white** with contrast-aware text.

## J. Trial → paid upgrade for migrated / legacy dealers
- [ ] A **migrated/legacy trial** dealer (carries `legacy_id`, no billing customer) can **upgrade**:
  a da-billing customer is created, `account_type` flips to the paid tier, the print gate unblocks, and
  the "Upgrade Now" CTA clears. (Previously stuck — no customer, account_type frozen on Trial.)
- [ ] An **orphan internal_id template** doesn't block the conversion (it's released first).
- [ ] An already-paying dealer **swapping tiers** keeps its `account_type` + funnel date (not re-converted).

## K. HubSpot sync fast-follows
- [ ] A dealer's **2nd user** syncs as a **Contact** (not just the first).
- [ ] **`prints_last_30` vs `prints_last_12mo`** are consistent (no 0-vs-31 mismatch).
- [ ] Computed-sync handles **>1000 dealers** (no row cap truncation) and **won't move a lifecyclestage
  backward** (e.g. Customer → Trial).
- [ ] **"How did you find us?"** signup value lands on the contact's **Referred By**.
- [ ] **DA User** property populates per the rule (the users that should be flagged are).

## L. SuperAdmin row actions — uniform Edit / Ghost / Impersonate
- [ ] **Groups and Dealers** lists both show the same row actions (**Edit / Ghost / Impersonate**).
- [ ] **Ghost** = operate without a user account (role stays super_admin); **Impersonate** = real session
  as that user (role downgrades); **Edit** opens the profile. Each does what its label says.

---

## M. 🔴 Cross-system EVENT PATHS (invisible/async — verify deliberately)
> These are fire-and-forget or cross-service, so a break is silent. Test each on a Test dealer/customer.

### M1. Billing-cache invalidate webhook (da-billing → platform)
- [ ] In da-billing, change a **locked** customer's **Overdue Days** (or confirm a payment) → the
  dealer's printing **unlocks within seconds** (the webhook), not the 20-min cache TTL.
- [ ] (Fail-open) if da-billing is unreachable, printing **still works**.

### M2. Group-discount sync (platform → da-billing)
- [ ] (Covered in §C) crossing a member-count tier updates the group's da-billing `subscriptionDiscount`.
- [ ] **Both** guards agree — no tier silently dropped (the 25% freeze regression).

### M3. Migration confirm → da-billing activate
- [ ] (Covered in §B3/B4) confirm sets active + future date, **no price**, group-billed → group customer;
  operator-activate closes the review-queue.

### M4. HubSpot fires
- [ ] **Event-driven:** create/update a dealer or group, or accept an invite → the Company/Contact
  upserts in HubSpot (portal 23896347).
- [ ] **Reliable trial-create:** a new trial dealer lands as `Dealer Trial` (3× retry; a terminal
  failure would Mandrill-alert).
- [ ] **Daily computed-sync cron** refreshes `prints_last_30/12mo`, `dealers_in_group`, and Trial →
  Trial Expired (spot-check after it runs).
- [ ] **Lifecycle:** convert a trial → Customer; downgrade → Downgraded.

### M5. FreshBooks recurring-stop (operator-queued)
- [ ] A migration Confirm fires the **Mandrill alert** to the operator inbox to stop FreshBooks — and
  **never auto-calls FreshBooks** (token-rotation safety). ⚠️ When you do it by hand: **never dry-run
  then live-run** (the OAuth token rotates; the live run fails).

### M6. Past-due print-lock (still valid from 6/9 §2)
- [ ] Group-billed member of a past-due group → blocked, tooltip "contact your Group Administrator";
  self-billed past-due → "past-due invoice"; **current dealer prints fine**; super_admin bypasses.

---

## N. Admin Dealer → Billing — subscription parity (LIVE 2026-06-18 · commit `46fc316`)
- [ ] **Has-customer dealer:** the Billing tab shows **Current Subscription** (plan/price/next invoice) +
  a **Change Plan** picker (all tiers, da-billing prices); the **current tier is disabled**.
- [ ] **Change Plan** swaps the tier via the existing path — **no price is sent** to da-billing; invoices
  still render.
- [ ] **No-customer dealer:** the picker is the primary "set up billing" path; picking a tier provisions
  the customer + template; the **dup-safe "check for existing customer" link path is still reachable**.
- [ ] **Conversion confirm:** picking a plan for a **Trial/Free** dealer prompts a confirm (converts +
  starts billing); a plain **swap** of an already-paying dealer does **not** prompt.
- [ ] 🔴 **Live end-to-end (real Trial dealer — the one path pure logic can't prove):** picking a plan
  actually **creates the da-billing template**, flips **`account_type` → paid**, and moves **HubSpot
  Trial → Customer**; and a **Downgrade to Free on a $0-balance paid dealer** cancels recurring billing
  + sets Free. (Endpoints are the same ones already proven on the dealer side — this just confirms the
  admin surface drives them.)
- [ ] **Downgrade to Free** (reuses `/api/billing/me/close`): blocks on an **outstanding balance** (pay
  first), else sets **Free** + cancels recurring billing + HubSpot Downgraded + keeps log-in 60 days;
  shown only for paid dealers.
- [ ] **Group-billed** dealer: unchanged (read-only summary, no Change Plan / Close).

## O. ⏳ Quick Edit dealer modal (verify AFTER deploy)
- [ ] **super_admin-only** "Quick Edit" on the Dealers list opens a modal with **Subscription type**,
  **Feed Provider**, **Inventory ID**.
- [ ] **Subscription type** change updates the tier + HubSpot and does **not** re-price in da-billing.
- [ ] **Feed Provider** dropdown sets `inventory_provider`; a **DMS** vendor sets `is_dms=true`, a
  non-DMS false, "— none —" nulls both; reflects in HubSpot `feed_company`/`feed_company_type`.
- [ ] **Inventory ID** change shows the **vehicle-deactivation count** and applies only on **confirm**;
  a no-op save fires nothing.
- [ ] A **grouped** dealer edits identically to a standalone one.

---

## P. Post-6/18 ships (verify on prod — 2026-06-17/19)
- [ ] **Clear Print History (large lot):** on Dickson City Hyundai (1,799 vehicles) the dealer-wide +
  bulk + single clears all return 200 and flip indicators white; a small dealer still works; inactive
  history preserved; a forced error shows the real message (not "Bad Request"). (`5b61c37`)
- [ ] **Impersonation resolver:** impersonate a migrated uid-mismatch dealer → pages resolve the correct
  role + dealer_id, dealer UI shows, scoping correct; a normal matching-uid session is unchanged.
  (latent until migration waves; `d50c1cf`)
- [ ] **Admin Billing parity:** Dealers → [dealer] → Billing shows Current Subscription + Change Plan;
  converting a **Trial** dealer prompts a confirm + (live) creates the template + flips account_type→paid
  + HubSpot Trial→Customer; **Downgrade to Free** on a $0-balance paid dealer cancels recurring billing;
  **no price ever sent**; group-billed dealer unchanged. (`46fc316`)
- [ ] **Builder widgets:** MSRP **"Divider line above"** draws a line above the row (canvas + PDF); Header
  Bar **font size + color** change (canvas + PDF); existing templates render identically. (`1e1b93f`)
- [ ] **SuperAdmin Starter Layouts:** super_admin creates/edits/deletes starters in SuperAdmin Builder;
  dealer/group Builder **"+ New"** lists Blank + starters; picking one clones into a new unsaved doc that
  Save writes as the dealer's own (starter unchanged); non-super write **403**, dealer GET **200**.
  (`01b376b`/`66ce1e8`)
- [ ] **Group → dealer control:** as a group (impersonate) → My Group → **Switch to Dealer** → operate with
  full control → **upload a logo** (the previously-denied action) → **Exit returns to My Group**; switch in
  from the Dealers list → Exit returns *there*. (`6a2538a`)
- [ ] **Spaces default:** a new product rule defaults **Spaces = 0**; an ETL run doesn't reintroduce 2.
  (migration 106)

## Suggested sequence
1. **§A** (promoted-now-shipped) + **§M event paths** — the easy-to-miss/silent ones, do early. You/Alex.
2. **§B migration** end-to-end on a Test dealer (billing-sensitive) — you/Alex; **§C/§D** money rules.
3. **§E–§L** feature/UI checks — hand the lighter ones (E password/email, F positioning, G badge, I
   widgets) to Marlena on a Test dealer where mutating.
4. **§N is live (commit `46fc316`) — run it now**, incl. the real-Trial conversion + $0 Downgrade
   end-to-end; **§O** once it deploys.
5. Finish any unchecked **§0–§14 from the 6/9 doc** (deploy mechanics, billing integrity, BI,
   group-billed view, invoice view/download, fuel rule, account-purpose, `?type`, multiprint).
