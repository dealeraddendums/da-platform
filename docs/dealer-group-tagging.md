# Dealer & Group Tagging (search / count / group-by-tag)

> Owner: Allan. Created 2026-06-19. Free-form tags on dealers AND groups, searchable + countable, so
> cross-cutting sets that name/ID/group can't express (e.g. **AutoNation dealers scattered across
> different groups and names**) can be grouped, counted, and — later — bulk-edited. STOP for review per
> phase.

## Decision (Allan, 2026-06-19)
- Tags apply to **dealers and groups**, one shared tag namespace (a single "AutoNation" tag assignable
  to either).
- **Access:** **super_admin** (full — tag anything, search all, manage the tag list) + **group_admin**
  (assign/search within their **own group's** dealers, and create tags). Tag **management**
  (rename / merge / delete) is **super_admin-only**.
- **Phasing:** v1 = tag · assign · search/filter · **count**. v2 = tag-management view. v3 =
  bulk-edit-by-tag (deferred — needs its own field scoping).

## Why a normalized store (not a text[] column)
The Dealers and Groups lists search **server-side with pagination** (`/api/dealers?q=` /
`/api/groups?q=`), and we need accurate counts + a canonical tag list for the picker + rename-once. So:
a `tags` table + `dealer_tags` / `group_tags` join tables. A `text[]` column would drift
("AutoNation" vs "Autonation"), can't autocomplete from a shared list, and makes counts/rename painful.

## Data model
- **`tags`** — `id uuid pk`, `name text` (**case-insensitive unique** — unique index on `lower(name)` so
  the picker reuses one "AutoNation" no matter how it's typed), `color text null` (chip color — use the
  **established badge palette**, no new colors), `created_by uuid`, `created_at timestamptz`.
- **`dealer_tags`** — `dealer_id uuid` FK → `dealers(id)` ON DELETE CASCADE, `tag_id uuid` FK →
  `tags(id)` ON DELETE CASCADE, `created_by`, `created_at`; `UNIQUE(dealer_id, tag_id)`; index on
  `tag_id` and on `dealer_id`.
- **`group_tags`** — same shape for `groups(id)`.
- RLS: `tags` + both join tables **readable by any authenticated user**; **writes go through the
  role-gated API** (admin client + role check), consistent with the platform's other write paths.

## Access model
- **Create a tag:** super_admin + group_admin (the picker's "Create '<x>'"; create normalizes/dedupes by
  `lower(name)` so an existing tag is reused, never duplicated).
- **Assign/unassign** to a dealer: super_admin (any) · group_admin (in-group only — `authorizeDealerAction`).
  To a group: super_admin (any) · group_admin (their **own** group only).
- **Search/filter by tag:** super_admin (all) · group_admin (results stay scoped to their group's
  dealers, exactly as the lists already scope).
- **Manage** (rename / recolor / merge / delete a tag): **super_admin only** (it's a shared namespace).

## API
- `GET /api/tags?q=` — list tags (id, name, color, **dealer_count**, **group_count**), ordered by name;
  `q` filters for the picker autocomplete. Any authenticated user.
- `POST /api/tags` — create (super_admin + group_admin); dedupe by `lower(name)` (return the existing
  tag if it already exists). 
- `PATCH /api/tags/[id]` (rename/recolor) + `DELETE /api/tags/[id]` (+ optional `?mergeInto=`) —
  **super_admin only**.
- `GET` + `PUT /api/dealers/[id]/tags` — read / set a dealer's tags. super_admin any; group_admin
  in-group (`authorizeDealerAction`).
- `GET` + `PUT /api/groups/[id]/tags` — same for a group (group_admin: own group only).
- **Extend `GET /api/dealers`**: accept a `tag` filter (tag id or name) → filter via `dealer_tags`
  (keep the existing pagination + `count:"exact"`, so the count reflects the tag); also let the
  free-text `q` match **tag names** (so typing "autonation" surfaces tagged dealers). Return each row's
  tags for chip display. group_admin results stay group-scoped.
- **Extend `GET /api/groups`** similarly.

## UI
- **Dealer profile (`DealerProfileCard`) + Group profile (`GroupProfileCard`):** a **Tags** field — chips
  + an editable picker that autocompletes existing tags (`GET /api/tags?q=`) and offers **"Create
  '<x>'"**. Save via `PUT /api/dealers/[id]/tags` (or groups). Shown for super_admin always; for
  group_admin on in-group dealers / their own group.
- **Dealers list + Groups list:** a **tag filter** (chips/dropdown of tags) beside the search box;
  selecting a tag filters the (server-side) list to it and the existing **count** reflects the set
  (→ "how many AutoNation dealers"). The free-text search also matches tag names. Show each row's tag chips.
- **Tag management view (v2, super_admin):** all tags with dealer + group counts; rename / recolor /
  **merge** (fix dupes) / delete. The per-list filter already gives counts in v1; this is housekeeping.

## Phasing
- **v1 (this prompt):** tables + API + profile tag pickers + list tag-filter/search/count. Delivers the
  core loop: tag the AutoNation dealers → filter → see the count.
- **v2:** the super_admin tag-management view (rename/merge/delete + an all-tags count dashboard).
- **v3:** **bulk-edit-by-tag** — filter by tag → select → apply a change. Define the editable fields
  (products, settings, disclaimers, …) when we get there.

## File touchpoints
- Migration: `supabase/migrations/<next>_tags.sql` (DDL via Supabase SQL editor — CC writes the file +
  hands Allan the SQL).
- API: `app/api/tags/route.ts` + `app/api/tags/[id]/route.ts`; `app/api/dealers/[id]/tags/route.ts` +
  `app/api/groups/[id]/tags/route.ts`; extend `app/api/dealers/route.ts` + `app/api/groups/route.ts`.
- UI: `components/DealerProfileCard.tsx`, `components/GroupProfileCard.tsx` (tag picker);
  `components/DealerList.tsx`, `components/GroupList.tsx` (filter + chips); a shared `TagPicker` component.
- Authz: reuse `lib/dealer-authz.ts` (`authorizeDealerAction`) for dealer-tag writes.

## Verify
- super_admin: tag a dealer + a group; the same tag is reused (not duplicated) across both and across
  case; filter the Dealers list by it → correct set + count; search "autonation" surfaces them.
- group_admin: can tag/search **their own** group's dealers (and their group); cannot tag or see an
  out-of-group dealer's tags (403 / not shown); cannot rename/delete a shared tag.
- A real dealer_admin / dealer_user is unaffected (tags read-only or hidden per decision — default:
  not editable by dealer roles in v1).
- STOP for review (new tables + many routes) before deploy.
