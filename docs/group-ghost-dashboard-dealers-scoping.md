# Bug — group-ghost view not scoped on Dashboard + Dealers

> For Claude Code. Owner: Allan. Created 2026-06-02.
> When a super_admin uses "ghost as group" (banner: *Operating as Group Admin*),
> the **Dashboard** shows platform-wide data (all dealers, 1,579 paying, full map
> + live activity) and the **Dealers** tab shows all 2,027 dealers — instead of
> the ghosted group's members. My Group, Builder, Vehicles, Users, Options and
> Settings already honor the group ghost; Dashboard + Dealers are the two misses.

## Root cause
The group-ghost token (`da_ghost_token`, signed in `app/api/admin/ghost/route.ts`
with `group_id` + `group_name`) is read correctly by `app/(dashboard)/layout.tsx`
(sidebar + ImpersonationBanner) and the builder/vehicles/users/options/settings/
profile pages. But:
- **`app/(dashboard)/dashboard/page.tsx`** reads the token yet only checks
  `ghostCtx.dealer_text_id` (dealer ghost). A GROUP ghost (`group_id`, no
  `dealer_text_id`) falls through to the super_admin platform branch (~line 203).
- **`app/(dashboard)/dealers/page.tsx`** doesn't read the token at all — it
  branches on the real `profile.role` (= super_admin) → `<DealerList>` (all dealers).

A **real `group_admin` login is already scoped correctly** on both pages (the
`role === "group_admin"` branches exist and work). This is specific to the
super_admin group-GHOST view — not a privilege escalation (the viewer is a
super_admin either way), but the ghost view must reflect what the group sees.

## Fix — route the group ghost into the existing group_admin paths
Both pages already have working `group_admin` branches; just feed them the
ghosted group id, mirroring the dealer-ghost pattern already in the dashboard.

### `app/(dashboard)/dashboard/page.tsx`
- Compute once (the ghost token is already read at ~line 150):
  ```ts
  const groupGhostId =
    role === "super_admin" && ghostCtx?.group_id && !ghostCtx?.dealer_text_id
      ? ghostCtx.group_id : null;
  ```
- Guard the platform branch so it does NOT run under a group ghost:
  `if (role === "super_admin" && !groupGhostId) { …platform view… }`.
- Run the existing group_admin branch when `role === "group_admin" || groupGhostId`,
  with `const groupId = groupGhostId ?? profile?.group_id ?? null;`. Everything
  inside (paid/trial counts, map dealers, addendums-this-month,
  `<ActivitySection groupId={groupId} />`) is already scoped by that groupId.

### `app/(dashboard)/dealers/page.tsx`
- Read the ghost token (same `verifyGhostToken(cookies().get("da_ghost_token")?.value)`
  pattern as the vehicles/users/options pages). If `role === "super_admin"` and
  `ghostCtx?.group_id && !ghostCtx?.dealer_text_id`, render
  `<GroupDealerList groupId={ghostCtx.group_id} />` instead of the super_admin
  `<DealerList>`.

### Confirm the data APIs honor the group id (should already)
- `<ActivitySection groupId>` fetches `/api/dashboard/recent-prints?group_id=…`
  for the live feed (map uses the server-scoped `dealers` prop). Verify
  `recent-prints` filters by `group_id` when passed.
- `GroupDealerList` fetches only its `groupId`'s dealers (used by real
  group_admins) — confirm it scopes by the prop, not by caller role.

## Verify (ghost as Dealer General — 196 dealers)
- Dealers tab → **196** (the group's dealers), not 2,027.
- Dashboard → group cards (Paid / Trial / Dealers = 196 / Addendums this month);
  map shows only the 196; Live Activity lists only group dealers' prints.
- Exit Ghost Mode → super_admin platform dashboard + all-dealers list return.
- A real `group_admin` login is unchanged (already scoped).
- Stop for review before deploy.
