# Bug — group_admin "Switch to Dealer" doesn't scope the pages

> For Claude Code. Owner: Allan. Created 2026-06-05.
> A group_admin (allan@allantone, Dealer General) clicks **Dealers → Switch to Dealer**
> for Mercedes Benz of Collierville. The topbar + sidebar switch correctly (← Back to
> Group, dealer nav), but: **Dashboard still shows the GROUP view** (188 paid / 196 in
> group + the all-dealers US map), **no dealer inventory**, and **Products bounces back to
> Dashboard**.

## Root cause — the layout honors `active_dealer_id`, the pages don't
"Switch to Dealer" sets `profiles.active_dealer_id` (`PATCH /api/profiles/active-dealer`,
group-scoped + verified). `getJwtClaims` then resolves, for a group_admin with
`active_dealer_id`: `role='group_admin'` **but** `dealer_id` = the active dealer's text id
(`lib/auth.ts` ~124–134).
- **Layout (correct):** `app/(dashboard)/layout.tsx` selects `active_dealer_id` and sets
  `sidebarRole = (isGroupAdmin && activeDealerUuid) ? "dealer_admin" : …` (line ~117) — so
  the sidebar shows the dealer nav and the topbar shows the dealer + "Back to Group."
- **Dashboard page (bug):** `app/(dashboard)/dashboard/page.tsx` re-queries the profile and
  selects only `role, dealer_id, group_id` (**not** `active_dealer_id`), then branches
  `if (role === "group_admin") → GroupAdminView` (group stats + all-dealers map). It never
  checks `active_dealer_id`, so it always renders the group view.
- **Products page (bug):** the "Products" nav → `/options`, gated to
  `dealer_admin`/`dealer_user`. A group_admin's real role is `group_admin`, so `/options`
  rejects them → redirect to `/dashboard`.

So the chrome switches to the dealer while the **page bodies** stay group-scoped or reject
the group_admin.

## Fix — treat group_admin + `active_dealer_id` as "acting as that dealer" everywhere
Mirror the layout's `sidebarRole` rule in the dealer-scoped **pages**. Best: extract a small
shared helper (e.g. `lib/active-dealer.ts → resolveDealerContext()`) returning
`{ effectiveRole, dealerId, activeDealerUuid }` where `effectiveRole = (role === 'group_admin'
&& active_dealer_id) ? 'dealer_admin' : role` and `dealerId` = the active dealer's **text**
`dealer_id` (resolve `dealers.id → dealer_id`). Use it in layout + every dealer-context page
so they agree.
1. **`dashboard/page.tsx`:** select `active_dealer_id`; add a branch **before** the
   group_admin branch — `if (role === 'group_admin' && active_dealer_id)` → resolve the
   active dealer's text id and render the **dealer view** (dealer stats +
   `<ManualVehicleInventory dealerId={textId} printGate={await canPrintForDealer(textId)} />`),
   exactly like the existing super_admin dealer-ghost branch. (This also removes the
   unwanted all-dealers map.)
2. **`/options` (Products)** and any other dealer-context page reachable from the active-dealer
   nav (**Builder**, **Print Settings**, **Order Supplies**, dealer **Users**): allow a
   group_admin **when `active_dealer_id` is set** and scope to `claims.dealer_id` (already the
   active dealer's id via `getJwtClaims`). Don't reject/redirect.
3. **"Back to Group"** already clears `active_dealer_id` (PATCH null) → pages fall back to the
   group view. Keep that.

## Security (unchanged)
The active-dealer PATCH already verifies the target dealer is in the group_admin's group —
keep it. Pages should trust the server-resolved `claims.dealer_id` (not a client-supplied id).

## Verify
- group_admin → Dealers → Switch to Dealer (Mercedes Benz of Collierville): Dashboard shows
  **that dealer's vehicles + dealer stats**, no group map; **Products/Options** loads that
  dealer's products; Builder + Print Settings scope to it.
- "Back to Group" restores the group dashboard (stats + map).
- A real dealer_admin/dealer_user is unaffected; a group_admin with **no** active dealer still
  sees the group view.
- Stop for review before deploy.
