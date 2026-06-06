# Group detail — Member Dealers sort/search + tabs above the list

> For Claude Code. Owner: Allan. Created 2026-06-05.
> On a big group (Dealer General, 196 members) the member list is unwieldy: no
> sort/search, and the Users/Billing/etc. tabs get pushed far below it.

## Current structure
- `app/(dashboard)/groups/[id]/page.tsx` renders `<GroupProfileCard>` (group header +
  info/location cards **+** the Member Dealers table) then `<GroupOptionsPanel>` (the
  tabs: Users / Billing / Corporate Products / Disclaimers / Templates).
- The member table is the `GroupDealers` sub-component inside `GroupProfileCard`
  (`components/GroupProfileCard.tsx` ~line 462). It fetches the **full** member list into
  `dealers` state (~line 517), so sort/search can be **client-side**. Columns: Dealer ID,
  Name, Inventory Dealer ID, Status, Location, Controls Templates, Subscription, Labels.

## Change 1 — sortable + searchable member list (`GroupDealers`)
- **Search box** above the table: case-insensitive substring filter over **Name**,
  **Dealer ID** (`dealer_id`), and **Inventory Dealer ID** (`inventory_dealer_id`). Filter
  the loaded `dealers` array (no refetch). Show the filtered count.
- **Sortable headers** for **Name**, **Dealer ID**, **Inventory Dealer ID**: click to sort
  asc, click again for desc, with an indicator (▲/▼). Client-side sort over `dealers`
  (Name via `localeCompare`; IDs natural/string compare). Default stays Name asc (the
  existing on-add sort). Keep it client-side — 196 rows is fine; flag server-side only if a
  group ever gets very large.

## Change 2 — move the tabs above the member list
Target visible order on the group page:
1. Group header (name, status, Edit Group)
2. Group info + Location cards
3. **Tabs** (`GroupOptionsPanel`: Users / Billing / Corporate Products / Disclaimers / Templates)
4. **Member Dealers** table (long — at the bottom)

Cleanest refactor: have `GroupProfileCard` render only the header + info/location cards (+
its modals), **lift the `GroupDealers` member table out**, and in `page.tsx` order it:
`<GroupProfileCard/>` → `<GroupOptionsPanel/>` → `<GroupDealers groupId … />`. (Or pass the
tabs panel into GroupProfileCard as a slot rendered above the member table — CC's call.)
End state must be: group info → tabs → member list.

## Verify
- Dealer General: search "Arrigo" / a dealer id / an inventory id each narrows the list;
  Name / Dealer ID / Inventory Dealer ID headers sort asc↔desc.
- Tabs (Users/Billing/…) appear right under the group info cards, not below the 196-row
  list; clicking a tab still works.
- group_admin and super_admin views both correct (the member table renders for both).
- Stop for review before deploy.
