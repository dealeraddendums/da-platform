# Regional Manager = tag-scoped `group_user` role

> Owner: Allan. Created 2026-06-19. Builds on dealer/group tagging. Large groups/resellers have
> **regional managers** who need group access — but scoped to **only the dealers tagged for them**, with
> full dealer-level control over those, and **none** of the group-admin powers. Authorization across many
> surfaces — stage carefully, STOP for review per phase.

## Decision (Allan, 2026-06-19)
- **Role:** the **existing but unused `group_user`** role (enum has it + label "Group User"; nothing
  references it today — every scope check is `group_admin`). We implement it as the regional manager.
  (UI label can be "Regional Manager" or "Group User" — Allan's call; key stays `group_user`.)
- **Scope = their group ∩ their assigned tags.** A group_user sees/manages ONLY the dealers in their
  group that carry one of their tags.
- **Control:** over those tagged dealers, **full dealer_admin parity** (exactly like a group_admin
  switched into a dealer — build, print, inventory, settings, order supplies, that dealer's billing).
- **Group config:** **dealer-level only** — they view/inherit the group's corporate products /
  templates / disclaimers / image library but **cannot edit** group-wide config (it would hit dealers
  outside their subset).
- **Cannot:** add new dealers · edit/create dealer or group tags · create/manage any user accounts ·
  edit group-level config · touch group-level billing · see or act on dealers not tagged for them.
- **Setup:** **group_admin + super_admin** create a group_user and assign its tag(s).
- **Phasing:** Phase 1 = the access model + restrictions (managers set up by super_admin to test);
  Phase 2 = group_admin self-service (invite a manager + manage their tags from the group Users tab).

## Scope model
- New join **`user_tags`** (`user_id uuid` → `profiles(id)` ON DELETE CASCADE, `tag_id uuid` →
  `tags(id)` ON DELETE CASCADE, `created_by`, `created_at`, `UNIQUE(user_id, tag_id)`).
- `getJwtClaims` resolves **`scope_tag_ids: string[]`** for a `group_user` (from `user_tags`, keyed on
  the resolved profile id — use the email-fallback-aware resolution). Empty tags ⇒ sees **no** dealers
  (safe default).
- A group_user's manageable dealer set = `dealers WHERE group_id = claims.group_id AND id IN
  (dealer_tags.dealer_id WHERE tag_id = ANY(claims.scope_tag_ids))`.

## Permission matrix
**CAN** (only on dealers in their group ∩ their tags):
- See them in the dealer list / their home; **switch into** one (active-dealer) → full dealer_admin
  control: Builder (build/save templates), Print + bulk print, inventory + settings (logo, nudge, AI
  toggle), order supplies/labels, and **that dealer's** billing (view/change subscription, downgrade —
  same as group-admin-as-dealer parity).
- Manage that dealer's **own staff users** (add/edit dealer_admin/dealer_user) — like a
  group_admin-in-dealer. (Only GROUP-level user creation is blocked — see CANNOT.)
- See the tags on their dealers (read-only).

**CANNOT:**
- See or act on dealers **not** tagged for them (even in-group) → 403 / not listed.
- Add/create new dealers.
- Edit dealer or group **tags**, or create tags.
- Create/manage **GROUP-level** users (other regional managers / group admins). *(They CAN manage their
  tagged dealers' own staff users — dealer-level parity, above.)*
- Edit **group-level** config — corporate products, group templates, disclaimers, group image library,
  group profile — or group-level billing. (View/inherit only.)

## Enforcement points (Phase 1 audit — mirror where `group_admin` is handled, add the tag check)
1. **`getJwtClaims`** — populate `scope_tag_ids` for `group_user`.
2. **`lib/dealer-authz.ts authorizeDealerAction`** — add a `group_user` branch: ok iff
   `dealer.group_id === claims.group_id` **AND** the dealer carries a tag in `claims.scope_tag_ids`
   (a `dealer_tags` lookup). This single helper gates all the dealer-context write routes, so the
   full-parity actions "just work" for tagged dealers and 403 for the rest.
3. **`PATCH /api/profiles/active-dealer`** — allow `group_user`; verify the target dealer is in-group
   **AND** tagged for them (extend the current group_admin in-group check).
4. **`GET /api/dealers`** — `group_user` branch: scope to `group_id` **AND** tagged-for-them (keep
   pagination + count). Same idea anywhere the dashboard / lists scope by group.
5. **UI / nav:** a group_user's home is a **scoped dealer list** (their tagged dealers, each with
   "Switch to Dealer") — NOT the group-admin page. Hide: the My Group admin tabs (Users, Corporate
   Products, Disclaimers, Templates, group Billing/Edit), **Add Dealer**, **Invite User**, and the
   **tag picker** (tags shown read-only). Nav ≈ Dashboard · My Dealers · My Profile · Help.
6. **Restriction guards (server-side, not just hidden UI):** `group_user` is rejected by — dealers
   POST (add dealer), `/api/tags` POST + dealer/group `…/tags` PUT (tag create/edit), the **GROUP-level**
   user/invite routes (`/api/groups/[id]/users`, group invite, `/api/users`), and the group-config write
   routes (corporate-products, group-templates, disclaimers, group image-library, group PATCH). Don't
   rely on hidden UI alone. **NOTE:** the **dealer-level** user routes (`dealers/[id]/users`,
   `dealers/[id]/invitations`) are **ALLOWED** for a group_user on their tagged dealers (full parity —
   they manage dealership staff; the dealer invite route already only permits dealer roles, so they can
   never create a group-level user). Dealer billing is likewise allowed (parity).

## Account setup
- **Phase 1 (super_admin):** set a user's role to `group_user` + group, and assign their tag(s)
  (`user_tags`) — enough to create + test a regional manager.
- **Phase 2 (group_admin + super_admin self-service):** the group Users tab gains "Invite Manager
  (Group User)" + tag assignment, and edit-an-existing-manager's-tags. The invite route (today
  DEALER_ROLES only) accepts `group_user` when the inviter is group_admin/super_admin and stores the
  assigned tag ids → applied to `user_tags` on accept.

## File touchpoints
- Migration: `supabase/migrations/<next>_user_tags.sql` (DDL via Supabase SQL editor).
- Claims/authz: `lib/auth.ts` (`scope_tag_ids`), `lib/dealer-authz.ts` (`group_user` branch).
- Scoping: `app/api/profiles/active-dealer/route.ts`, `app/api/dealers/route.ts`, dashboard + list
  components; the group-config + add-dealer + tags + invite/user routes (add the `group_user` denial).
- UI: nav (`components/Sidebar.tsx`), a scoped dealer list for `group_user`, read-only tag display.

## Verify (the negative tests matter most)
- A `group_user` with tag "AutoNation" sees ONLY in-group AutoNation dealers; switching into one gives
  full dealer control (build → print → inventory/settings → that dealer's billing).
- The SAME user on an in-group dealer **without** their tag → 403 / not listed; on an out-of-group
  dealer → 403.
- The user **cannot** add a dealer, edit/create a tag, invite/manage users, or edit any group-level
  config (each blocked **server-side**, not just hidden).
- group_admin + super_admin are unchanged; a real dealer_admin/dealer_user unchanged.
- Confirm there are **no pre-existing `group_user` accounts** that would change behavior on deploy
  (the role was inert) — or that any found are intended.
- STOP for review (authorization touches many routes).
