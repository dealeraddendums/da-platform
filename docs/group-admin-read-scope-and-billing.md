# Fix — group_admin authorization: group-scoped reads + active-dealer billing

> For Claude Code. Owner: Allan. Created 2026-06-05. Allan's decisions on the two
> route-audit residuals. Same theme as `group-admin-template-save.md` /
> `group-admin-active-dealer-scoping.md`.

## Part 1 — group_admin reads must be group-scoped (not all dealers)
**Decision (Allan): a group_admin may only read dealers their group manages — never all
dealers.** Two routes currently let a group_admin read any dealer's data with no
group-ownership check:
- **`options/library`** (dealer options) — add the check (oversight).
- **`dealers/[id]/corporate-products`** — previously documented as "intentional"; **Allan has
  overruled** — scope it to the group too (a group_admin may read corporate products only for
  dealers **in their group**).

Fix: for `claims.role === 'group_admin'`, verify the target dealer's `group_id ===
claims.group_id` before returning data — `super_admin` bypasses; `dealer_admin`/`dealer_user`
are already scoped to their own dealer. Reuse the existing pattern from `resolveDealerId`
(`app/api/templates/route.ts`): look up the dealer's `group_id` and return **403** on
mismatch.

**Sweep:** the earlier route audit covered **write** paths (`?dealer_id`-required → 400/403).
This is a **read** gap — audit the other dealer-scoped **GET** routes a group_admin can reach
and add the same group-ownership check wherever it's missing, so the rule ("a group_admin sees
only its own group's dealers") holds platform-wide. Report what you find and fix.

## Part 2 — group_admin can manage a member dealer's billing while switched in
**Decision (Allan): a group_admin acting as a member dealer (active_dealer) is meant to manage
that dealer's billing.** Today `billing/me` and siblings use the `?dealer_id`-required shape
and don't honor a group_admin's active dealer → the same failure mode as the template save.

Fix: resolve the **active dealer** for a group_admin (`claims.dealer_id`, already group-verified
when selected via `PATCH /api/profiles/active-dealer`) across the billing routes the
dealer-context Billing tab calls — `GET /api/billing/me`, `PATCH /api/billing/me/subscription`,
`POST /api/billing/me/close`, and any other `billing/me*` route — mirroring the template-save
fix (honor `claims.dealer_id`, with the defensive `group_id` re-check). `super_admin` and
`dealer_admin` paths unchanged.

## Verify
- A group_admin can read/manage **options**, **corporate products**, and **billing** only for
  dealers **in their group**; a dealer outside the group → **403**.
- A group_admin switched into a member dealer can view and change that dealer's subscription and
  close/downgrade as intended; a real `dealer_admin` and `super_admin` are unaffected.
- Stop for review before deploy (auth + billing path).
