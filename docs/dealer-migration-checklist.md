# Per-dealer migration checklist (Platform 4.0 → V5.0) — current state

> Owner: Allan. 2026-06-12. The **manual / white-glove** path to move one existing 4.0 dealer to V5.0.
> Reconciles the CLAUDE.md migration procedure with current reality: the ETL has **pre-staged** the
> dealer's data, and da-billing **already holds** the customer + template (now **paused** by the
> 2026-06-12 reset). So migration is **verify + flip switches**, not a cold copy. This is also the path
> **Phase 13** will automate for self-serve.

## Already done by automation (just verify)
- **DA Legacy ETL** synced the dealer's record, group, users/profiles, settings, addendum options,
  vehicles + print status, and logo (Aurora → Supabase). **DA Pulse** keeps inventory current. → the
  5.0 account exists, dormant.
- **da-billing** already holds the dealer's `customer:*` + `template:*` (migration-prep), currently
  `template.active = false` (paused).

## Steps (per dealer)
1. **Verify Supabase data** (QA pass): dealer record + Supabase UUID; group assignment; users/profiles;
   `dealer_settings` (platform defaults + Allan's Infosheet); vehicles + options; logo. Fix any gaps.
2. **Invite the user(s) to set up the 5.0 login** — scanner-proof **OTP invite** (email leads with the
   code → passkey or password; no password carried over). Service-provider groups (e.g. Dealer General):
   the group_admin operates; member stores may never log in.
3. **Billing cutover:**
   - a. Suspend the dealer's **FreshBooks** subscription (legacy billing). ⚠️ FreshBooks OAuth refresh
     token rotates on every use — **never dry-run then live**.
   - b. **Activate** the da-billing template — set `template.active = true` (the pre-staged, paused
     template; this is **un-pause**, NOT "create a customer"). Confirm `nextInvoiceDate` is correct
     (anniversary/cutover date — not a stale past date that triggers a catch-up invoice).
   - c. Confirm `account_type` is the correct **Paid** tier (a paying 4.0 dealer → Paid on 5.0, can
     print — not Trial).
4. **Flip `migration_status = 'migrated'`** on the dealer → the ETL stops touching them (5.0 is source of
   truth) and the HubSpot lifecycle stage updates.
5. **Notify** — welcome email with the **Platform 5.0** login link.

## Groups
Migrate all member stores **together** (shared group UUID); apply group-level template overrides;
spot-check 2–3 members.

## Post-migration state
4.0 stays accessible · FreshBooks suspended · da-billing active · Aurora still feeds DA Pulse vehicle
sync.

## Verify
- Dealer logs into 5.0 (OTP) → sees their dealership, templates, products, inventory; can print.
- da-billing: template active + a correct next invoice; FreshBooks suspended; no duplicate billing.
- HubSpot: lifecycle stage = Customer; **all** the dealer's users show as Contacts (depends on the
  user-sync fix — see HubSpot sync fixes 2026-06-12).
