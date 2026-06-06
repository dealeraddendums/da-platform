# Bug — Self-serve Trial dealer can't upgrade ("Forbidden", then no billing customer)

> For Claude Code. Owner: Allan. Created 2026-06-02. A self-serve **Trial** dealer
> (over the 30-print limit) opens BillingTab → picks a paid plan → **"Forbidden."**
> Two issues stacked; fix both or the second surfaces once the first is fixed.

## Bug 1 — the "Forbidden" (role not resolving as `dealer_admin`)
> **Likely root cause (2026-06-02): there were TWO `allan@allantone.com` accounts in
> the system.** With duplicate same-email profiles, `getJwtClaims`'s email fallback
> can resolve the *wrong* profile (a `dealer_user`/mismatched row) → the PATCH role
> gate 403s even though the real dealer_admin profile is correct. Two-part fix:
> **(a) prevent duplicates** — harden `selfServeDuplicateExists` and lean on
> auth.users email-uniqueness so a second same-email account can't be created;
> **(b) make claims resolution unambiguous** — prefer the exact `session.user.id`
> match and don't let the email fallback pick an arbitrary duplicate. (Allan is
> deleting both test accounts to retest clean.)
- `PATCH /api/billing/me/subscription` 403s "Forbidden" unless `claims.role ∈
  {dealer_admin, super_admin, group_admin}` (route ~line 36–42). The BillingTab
  **loads fine** (GET `/api/billing/me` works) — so it's specifically the plan-change
  PATCH being rejected → **this self-serve user's resolved role isn't `dealer_admin`.**
- `lib/provisioning.ts → createAdminUserWithInvite` sets `role: 'dealer_admin'` in
  both `app_metadata` and the `profiles` upsert, so it *should* stick. **Investigate
  why it doesn't for self-serve users:**
  - **Confirmed via the Users page (2026-06-02): this user's stored `role` IS
    `dealer_admin` and `dealer_id` = `ss_1780516690241`.** So the DB row is correct —
    this is a **claims-resolution** bug: `getJwtClaims` is returning the `dealer_user`
    default for this session despite the profile being dealer_admin. Focus the
    investigation there (session.user.id ↔ profile.id match + the email fallback for
    an OTP/passkey session), not the stored role.
  - Prime suspect — the `handle_new_user` trigger vs the upsert: line ~157 is
    `.upsert(profile)` **without `{ onConflict: "id" }`** (the codebase's documented
    rule — see QA Bug Fix History — is to upsert profiles with `onConflict: "id"` so
    the trigger's default-role row gets UPDATED, not left in place). Confirm the role
    actually updates; if not, add `{ onConflict: "id" }`.
  - Confirm `getJwtClaims` resolves the profile by `session.user.id` for an
    OTP/passkey session (not falling back to the `dealer_user` default).
- Fix the root cause **and backfill** any self-serve users already created with the
  wrong role → `dealer_admin`.

## Bug 2 — trial → paid upgrade needs a da-billing customer (the next wall)
Even with the role fixed, the upgrade fails at the billing layer: a self-serve
**Trial** dealer has **no da-billing customer** (billing is intentionally skipped at
trial). The PATCH uses `customerKey = billing_customer_id ?? internal_id` (non-null,
so it proceeds) then `getTemplate`/`putTemplate` against a da-billing customer that
**doesn't exist** → error.
- **Fix:** on upgrade, if the dealer has no `billing_customer_id`, **create the
  da-billing customer + recurring template first** (reuse `createCustomer` +
  `createTemplate` from `fireAndForgetCustomerCreate` in `POST /api/dealers`), persist
  the returned `billing_customer_id`, THEN apply the tier. This is the **trial → paid
  conversion** (first subscription), not a tier swap.
- Also flip `dealers.account_type` to the chosen paid tier and fire a HubSpot sync —
  so the print-gate unblocks and lifecyclestage moves **Trial → Customer**.

## Bug 3 — "Unknown subscription tier" on upgrade (tier-key mismatch)
Surfaced once Bug 1 cleared (duplicate accounts deleted). The BillingTab's
`SUBSCRIPTION_TIERS` (`ProfileClient` ~1436) uses short keys
`manual`/`auto-web`/`auto-dms` and the change-plan call (~1492) sends the **`key`**
as `tier`. But `subscriptionDescriptorFor` (`lib/billing.ts` ~455) accepts `manual`
but **not** `auto-web`/`auto-dms` (it takes the `sub-…` productKeys / full names) →
`Unknown subscription tier "auto-web"`.
- **Fix:** send the canonical **`productKey`** (`sub-auto-web`, etc.) from the
  change-plan call instead of the short `key`.
- **Also harden** `subscriptionDescriptorFor` to accept the short
  `auto-web`/`auto-dms` keys too — `manual` already works, so the inconsistency is a
  trap waiting to bite again.

## Verify
- Self-serve Trial dealer (even over the print limit) → BillingTab → pick a paid plan
  → no "Forbidden"; a da-billing customer + template are created; `account_type` → the
  paid tier; printing unblocks; HubSpot lifecycle Trial → Customer.
- An existing paying dealer changing tiers still works (existing-customer path unchanged).
- Stop for review before deploy (billing + auth for dealers).
