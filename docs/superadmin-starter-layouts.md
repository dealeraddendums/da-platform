# SuperAdmin Starter Layouts (platform "+ New" presets)

> Owner: Allan. Created 2026-06-18. super_admin-managed platform starter templates that every dealer
> can start a new document from. Billing-irrelevant; Builder/template feature. STOP for review per phase.

## Decision (Allan, 2026-06-18)
A super_admin, under a left-nav **Documents → SuperAdmin Builder** link, sees the **starter layouts**
they've created and can **add / edit / delete** them. These starters are **platform-scoped —
available to ALL dealers** (any group, or single) as starting points when they click **+ New** in the
Builder. They are *starting layouts*, not assignments: picking one **clones** it into a new, editable
document the dealer then saves as their own.

## Why a new store (not the existing templates table)
`templates` is dealer-scoped (`dealer_id` NOT NULL, RLS keyed on the dealer); `group_templates` is a
separate group-scoped store. Platform starters are a **third scope** with no dealer/group — so they get
their own table, mirroring how group templates are separate. The `scope: platform|group|dealer`
precedent already exists in the image library (`lib/image-library.ts`).

## Data model — `starter_templates` (platform-scoped)
| col | type | notes |
| --- | --- | --- |
| id | uuid pk | |
| name | text | e.g. "Classic Addendum" |
| doc_type | text | `addendum` \| `infosheet` \| `buyers_guide` (so +New can show relevant starters) |
| paper | text | paper-size key (matches Builder PAPERS) |
| template_json | jsonb | the full layout — bg + widgets + fontScale (same shape `templates.template_json` uses) |
| sort_order | int | display order in the picker |
| created_by | uuid | super_admin who made it |
| created_at / updated_at | timestamptz | |

RLS: **readable by any authenticated user** (all dealers need to list them); **writes super_admin-only**
(enforced in the API via the admin client + role check, like other super_admin routes). DDL applied via
the Supabase SQL editor (per the migration pattern — not from the box); CC writes the migration file +
hands Allan the SQL.

## API — `/api/starter-templates`
- `GET /api/starter-templates?doc_type=` → list (id, name, doc_type, paper, updated_at, sort_order),
  ordered by sort_order. Any authenticated user.
- `GET /api/starter-templates/[id]` → full row incl. template_json. Any authenticated user.
- `POST` / `PATCH /[id]` / `DELETE /[id]` → **super_admin only**.

## Part 1 — SuperAdmin Builder (management)
- **Nav:** add a `Documents` section to the super_admin sidebar with a **SuperAdmin Builder** item
  (`roles: ["super_admin"]`, href `/starter-layouts`). (super_admin has no dealer Builder nav today —
  they reach the Builder by ghosting; this is their own entry point.)
- **Page `/starter-layouts`:** lists starter layouts (name · doc type · updated) with **Add / Edit /
  Delete**. Add/Edit opens the Builder in **platform-starter mode**.
- **Builder platform-starter mode:** `BuilderPage` today is dealer/group-scoped (`dealerId`/`groupId`
  props; load/save hit `/api/templates` or `/api/group-templates`). Add a `starterMode` (+ optional
  `starterTemplateId`) path so load/save target `/api/starter-templates`. No dealer context — the
  preview uses the existing sample vehicle data and a placeholder logo. The Save modal is simplified to
  **name + doc_type + paper** (no vehicle-type assignment, no "save as group template").

## Part 2 — dealer "+ New" picker
- The Builder **+ New** (BuilderPage "New template" handler, ~line 1200) currently blanks the canvas.
  Change it to open a small picker: **Blank** + the platform starters (`GET /api/starter-templates`,
  filtered to the current doc_type where sensible). Picking a starter **clones its template_json**
  (bg + widgets + paper + fontScale) into a new **unsaved** document; the dealer edits and **Save
  template** saves to their own `/api/templates` (starters are never mutated by dealers). **Blank** =
  today's behavior.
- Applies to dealer_admin + group_admin in the Builder. (In super_admin starter-mode, +New makes a new
  *starter*.)

## Phases (STOP for review per phase)
- **Phase 1** — `starter_templates` table + `/api/starter-templates` API + the **SuperAdmin Builder**
  (nav + `/starter-layouts` page + Builder platform-starter mode for create/edit/delete). Delivers the
  authoring side end-to-end.
- **Phase 2** — the dealer **+ New** picker that surfaces the starters (the consumer side). Depends on
  Phase 1's data.

## File touchpoints
- Migration: `supabase/migrations/<next>_starter_templates.sql` (check latest number).
- API: `app/api/starter-templates/route.ts` + `app/api/starter-templates/[id]/route.ts`.
- Nav: `components/Sidebar.tsx` (super_admin Documents section).
- Page: `app/(dashboard)/starter-layouts/page.tsx` + a client list component.
- Builder: `components/builder/BuilderPage.tsx` (starter-mode load/save + simplified save modal) +
  `app/(dashboard)/builder/page.tsx` or the new starter route mounting it in starter mode.
- +New picker (Phase 2): `BuilderPage.tsx` "New template" handler.

## Open assumptions (all shipped as written)
- +New shows **Blank + starters** (not starters-only).
- Starters are **full templates** (bg + widgets + paper), cloned on use.
- Nav label "SuperAdmin Builder" per Allan; page lists/manages "starter layouts".

---

## SHIPPED 2026-06-19 — live, end-to-end
- **Phase 1** (`01b376b`): `starter_templates` store + `/api/starter-templates` API + the **SuperAdmin
  Builder** authoring UI (Documents → SuperAdmin Builder → `/starter-layouts`; list + Add/Edit/Delete;
  Builder platform-starter mode with the simplified Save modal). Migration applied via Supabase SQL
  editor; Phase 1 verified end-to-end (super_admin CRUD, dealer read, non-super write 403).
- **Phase 2** (`66ce1e8`): the dealer/group Builder **"+ New"** now opens a *Start a new document*
  picker — **Blank** (unchanged) + the platform starters. Picking one clones its layout into a fresh
  **unsaved** doc; **Save** writes the dealer's own template; the starter row is never mutated.
  super_admin starter-mode "+ New" still makes a blank starter.
- Nav was consolidated (`66ce1e8` era) into a single lower **Documents** group:
  SuperAdmin Builder · Buyer's Guide PDFs · Image Library (the duplicate header was removed).

## Ops notes
- **Authoring:** super_admin only, via **Documents → SuperAdmin Builder**. Add/Edit opens the Builder
  in platform-starter mode; Delete confirms. Starters are **platform-wide** — every dealer/group sees
  them immediately (no per-dealer assignment).
- **Scope / security:** starters live in their own `starter_templates` table (separate from dealer
  `templates` and `group_templates`). RLS = **read for any authenticated user, writes
  super_admin-only** (writes go through the gated API; direct client writes 403). A dealer can never
  mutate a starter.
- **Seeding:** create a few starters (at least one per doc type you want offered) so the dealer picker
  has content. With zero starters, "+ New" falls straight through to Blank.
- **Deploy quirk:** the prod box's SSH allowlist is IP-locked and the deploy egress IP rotates, so a
  deploy may intermittently need a temporary port-22 SG rule (add → deploy → revoke). Handled
  per-deploy; no posture left behind.

## QA click-through (live)
1. **super_admin** → SuperAdmin Builder → create 1–2 starters (e.g. an Addendum + an Infosheet); Edit
   and Delete each work; rows persist.
2. **dealer / group** (ghost or impersonate) → Builder → **+ New** → picker lists **Blank + your
   starters** (with doc-type labels).
3. Pick a starter → layout (bg / widgets / paper / font) clones into a fresh doc → **Save template** →
   confirm a **new dealer template** is created, the **starter row is unchanged**, and the Save
   **doc-type matches** the starter.
4. **Blank** still resets exactly as before; with **no starters**, "+ New" goes straight to Blank.
5. **Auth:** a non-super_admin write to `/api/starter-templates` is **403**; a dealer GET of the list
   is **200**.
