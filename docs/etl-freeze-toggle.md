# super_admin "Freeze legacy ETL sync" toggle

> For Claude Code. Owner: Allan. Created 2026-06-07. The in-platform control for the ETL
> config-lock (`da-legacy-etl/docs/etl-config-lock.md`). Lets a super_admin freeze a dealer or a
> whole group from legacy sync without hand-SQL — this recurs for every account that goes live in
> limited capacity. **Uses migration 094** (`etl_locked`/`_at`/`_reason`/`_by` on dealers+groups).

## Who / where
- **super_admin ONLY.** Not dealer_admin, not group_admin — freezing legacy sync is an internal
  migration-ops control. (Mirror the existing `is_test` toggle's gating exactly.)
- **Dealer toggle:** `components/DealerProfileCard.tsx`, in the super_admin controls area next to
  the existing `is_test` toggle (the one that PATCHes `/api/dealers/{id}` with `{ is_test }` —
  copy that pattern).
- **Group toggle:** `components/GroupProfileCard.tsx`, super_admin area (gated by the existing
  `isSuperAdmin` prop passed from the group page).

## Behavior
**Label:** "Freeze legacy ETL sync"
**Help text:** "When on, the nightly legacy sync won't overwrite this account from Aurora — the
dealer is managing it in the new platform. Print history still syncs."

- **Toggle ON** → confirm, then `PATCH` with `{ etl_locked: true, etl_locked_reason: <optional> }`.
  - Offer an optional **reason** field in the confirm (small input or prompt); default reason
    `"Live on new platform (limited/parallel)"`.
  - **Group confirm must state the blast radius:** *"This freezes legacy sync for all N dealers in
    {Group}. Edits they make in the new platform will be preserved; legacy print activity still
    syncs."* (N = member count, already available on the group page.)
- **Toggle OFF** → confirm *"Resume legacy sync? On the next run, Aurora will overwrite any
  in-platform edits to this account again."* then `PATCH { etl_locked: false }`.
- After save, refresh the displayed state (no full reload needed; mirror is_test).

## API (super_admin-gated, mirror the `is_test`/`active` lines)
**`app/api/dealers/[id]/route.ts` PATCH** — add, alongside `body.active`/`body.is_test`:
```ts
if (body.etl_locked !== undefined && claims.role === "super_admin") {
  patch.etl_locked = body.etl_locked;
  patch.etl_locked_at = body.etl_locked ? new Date().toISOString() : null;
  patch.etl_locked_by = body.etl_locked ? claims.sub : null;
  patch.etl_locked_reason = body.etl_locked ? (body.etl_locked_reason ?? null) : null;
}
```
**`app/api/groups/[id]/route.ts` PATCH** — same block, **super_admin only** (do NOT include it in
the group_admin-allowed fields; group_admin can edit name/contact, never this).

`claims.sub` is the auth uuid (see `lib/auth.ts`). No HubSpot push — `etl_locked` is internal ops,
not a synced field.

## Visibility
- **Frozen badge** on the dealer/group profile header when `etl_locked` is true — e.g. a neutral/
  amber **"ETL Frozen"** badge. **Use the established badge palette; do not introduce a new color**
  (design-system rule). Tooltip/subtext: *"Frozen by {name} on {date} — {reason}"* (resolve
  `etl_locked_by` → profile name; fall back to the raw value if unresolved).
- **"Frozen via group" indicator (important):** the ETL cascade means a member dealer is
  effectively frozen when its **group** is `etl_locked`, even if the dealer's own flag is false.
  On a dealer page whose group is frozen, show a read-only note *"Frozen via group: {GroupName}"*
  and render the dealer-level toggle as **disabled** (control it at the group). Compute effective
  state = `dealer.etl_locked || dealer.group?.etl_locked`.
- **Optional:** a small "frozen" indicator column/filter on the Dealers and Groups list pages.

## Verify
- As super_admin, toggle a **dealer** on → badge shows; `dealers.etl_locked=true`, `_at`/`_by`/
  `_reason` set; toggle off → false. Reason captured.
- Toggle a **group** on → confirm shows the member count; `groups.etl_locked=true`; each member
  dealer's page shows "Frozen via group" with its toggle disabled.
- A **non-super_admin** (group_admin/dealer_admin) never sees the toggle, and a forged
  `etl_locked` in a PATCH body from those roles is **ignored** (server-side role gate).
- After freezing, the next ETL run leaves the account's config alone but still syncs print status
  (that's the `etl-config-lock.md` behavior — verify there).
- STOP for review before deploy.
