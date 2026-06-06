# Principle + audit — group_admin in a dealer == full dealer_admin for that dealer

> For Claude Code. Owner: Allan. Created 2026-06-06. **Umbrella** for the one-off
> group-admin-as-dealer fixes (`group-admin-active-dealer-scoping.md`,
> `group-admin-template-save.md`, `group-admin-read-scope-and-billing.md`,
> `builder-inventory-followups-0606.md` #1–#2). Auth across many routes — stage + review.

## Why (Allan)
When a group_admin enters one of their group's dealerships ("Switch to Dealer" / active
dealer), they have **full control to use and manage that dealer's account as if they were the
dealer.** This is not an edge case: some groups — e.g. **Dealer General** — don't give their
dealers account access at all; the group does **all** addendum printing and management for its
dealerships as a service. For those groups the group-admin-as-dealer path is the **primary**
way the account is operated, so it must be complete and reliable, not patched gap-by-gap.

## The rule
A **group_admin with an active dealer** (switched into an in-group dealer) is authorized
**exactly as a `dealer_admin` for that dealer** — every dealer-context action a dealer_admin
can take, the switched-in group_admin can take for that dealer. Guard: the active dealer must
belong to `claims.group_id` (the active-dealer PATCH already verifies this; routes re-check
defensively). With **no** active dealer, the group_admin keeps group-level powers only. The
group_admin never gains super_admin/platform powers, and cross-group access stays blocked.

## Implement once — a shared authz helper (stop per-route patching)
Add a shared helper, e.g. `lib/dealer-authz.ts`:
- `resolveEffectiveDealer(claims)` → the effective dealer_id (super_admin ghost, dealer's own,
  or a group_admin's active dealer), building on `getJwtClaims` (which already sets
  `claims.dealer_id` to the active dealer for a group_admin).
- `authorizeDealerAction(claims, dealerId)` → ok / 403, where ok =
  super_admin (any) · dealer_admin/dealer_user (`claims.dealer_id === dealerId`) · **group_admin
  (dealerId ∈ claims.group_id)**.
Route **every** dealer-scoped API and page gate through this helper so a route can't silently
omit group_admin parity. This is what `resolveDealerId` in `/api/templates` does for one route —
generalize it.

## Comprehensive audit — API authz AND UI controls
Apply the rule across **all** dealer-context surfaces. For each: (a) the API authorizes the
group_admin-as-dealer, and (b) the **UI shows the same controls** a dealer_admin sees (don't
hide dealer actions from a switched-in group_admin). Produce a **parity matrix**
(action × API-ok? × UI-shown?) so gaps are visible at a glance.
- **Builder:** template save/update (done), custom sizes add/edit/delete (`#1`), background +
  scoped image uploads, disclaimers (done), options/products, default-template settings.
- **Inventory:** vehicle add/edit (incl. new MPG fields), print + bulk print, clear print
  history bulk (`#2`) + individual, print-eligibility gate.
- **Settings:** dealer settings, printer nudge, AI toggle, logo upload.
- **Billing:** view/change subscription (done), self-close/downgrade (done), order
  supplies/labels.
- **Pages:** Dashboard, Products, Builder, Print Settings, Users, Order Supplies render the
  **dealer view + controls** for a switched-in group_admin (Dashboard/Products specced in
  `group-admin-active-dealer-scoping.md` — confirm it deployed).

## Verify
- As a group_admin switched into an in-group dealer, **every** dealer-context action works just
  as that dealer's own dealer_admin would — build → print → manage inventory/settings → bill →
  order supplies — end to end (the Dealer General "we run it for them" case).
- The same actions on an **out-of-group** dealer → 403.
- A real dealer_admin and a super_admin are unaffected.
- Stage the changes and **stop for review before deploy** (authorization touches many routes).
