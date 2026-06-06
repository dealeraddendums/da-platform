# Feature — dealer- and group-scoped images in the Builder

> For Claude Code. Owner: Allan. Created 2026-06-05.
> Dealers need to upload their own images for the Builder (background picker today),
> visible **only to that dealer**. Images a **group admin** adds go to a **Group
> library** visible to **all dealers in that group**. Platform images stay visible to
> everyone. Mirrors the Phase-8 Platform/Group/Dealer widget scoping.

## Today (what exists)
- `image_library` (migration 052): `bucket, s3_key, url, display_name, file_size,
  uploaded_at, uploaded_by`. **No owner/scope column.** RLS = super_admin writes, **any
  authenticated user reads** → every image is effectively platform-global.
- Upload: `POST /api/admin/image-library/upload` (**super_admin only**), buckets
  `new-addendum-backgrounds` (5 MB) / `new-infosheet-backgrounds` (10 MB).
- Builder background panel + `ImagePickerModal` ("Platform Backgrounds") read those
  buckets; upload is gated to super_admin (`canAdminUpload`).
- `builder-background-upload.md` explicitly flagged this: *"If dealers should upload their
  own backgrounds later … those must go to a per-dealer location, not the shared platform
  buckets (else every dealer's upload appears in everyone's picker)."* This is that feature.

## Scope model (Platform / Group / Dealer)
- **Platform** — uploaded by super_admin; visible to everyone (existing behavior).
- **Group** — uploaded/managed by a group_admin (or super_admin acting for a group);
  visible to **all dealers in that group**.
- **Dealer** — uploaded by a dealer (`dealer_admin`) or by a group_admin/super_admin acting
  as a dealer; visible to **that dealer only**.

## 1. Schema — migration 090
Add to `image_library`: `scope text NOT NULL DEFAULT 'platform' CHECK (scope IN
('platform','group','dealer'))`, `group_id uuid NULL`, `dealer_id text NULL` (dealer's text
`dealer_id`, consistent with the rest of the platform). Backfill existing rows →
`scope='platform'`. Index `(scope, group_id)` and `(scope, dealer_id)`.

Update RLS:
- **Read:** a row is visible if `scope='platform'` **OR** (`scope='group'` AND `group_id` =
  the requester's group) **OR** (`scope='dealer'` AND `dealer_id` = the requester's dealer).
  (Resolve the requester's group/dealer from `profiles`; for a group_admin acting as a
  dealer, the active dealer counts — see the active-dealer context work.)
- **Write:** super_admin → any scope; group_admin → `scope='group'` for their own
  `group_id`; dealer_admin → `scope='dealer'` for their own `dealer_id`. Keep the
  super_admin full-access policy.

## 2. Storage — per-scope S3 prefixes (no cross-leak)
Group/dealer uploads must **not** go to the shared platform buckets. Use scoped keys, e.g.
`group/{group_id}/{uuid}.{ext}` and `dealer/{dealer_id}/{uuid}.{ext}` (platform stays in the
existing `new-*-backgrounds` buckets). The picker filters by scope, but isolating the keys
is defense-in-depth so a bucket listing can never surface another dealer's image.

## 3. Upload — scope-aware (role-based)
Add a non-admin route (e.g. `POST /api/image-library/upload`) — or generalize the existing
one — that derives **scope from the caller** via `getJwtClaims`:
- super_admin → `platform` (current behavior; keep `/api/admin/image-library/upload`
  working).
- group_admin → `group` (`group_id` = claims.group_id).
- dealer_admin (or group_admin/super_admin with an active dealer) → `dealer`
  (`dealer_id` = the effective dealer).
Reuse the existing type/size validation. Persist `scope` + `group_id`/`dealer_id` on the
`image_library` row. Never let a caller write a scope/owner they don't belong to.

## 4. List + picker
- A scoped list endpoint returns the images **visible to the current user** — platform +
  their group + their (active) dealer — each tagged with its scope.
- `ImagePickerModal` renders **sections**: **Platform**, **{Group name} Library**, **My
  Images** (only the sections that have images). The existing search filters across all.
- The **Upload** control is shown to **dealer_admin** (→ dealer) and **group_admin** (→
  group), not just super_admin; the uploaded image lands in the caller's scope and appears
  in the matching section without a full reload. A dealer can **delete only their own**
  images; a group_admin only the group's; super_admin any.

## 5. Group Admin Image Library surface
Give group_admins a place to manage the group library (the "available to all dealers"
set), mirroring the super_admin `app/(dashboard)/admin/image-library` page but scoped to
their group — e.g. an **Images** tab on the group page (alongside Users/Billing/Corporate
Products/Disclaimers/Templates) or a nav item in the group_admin context. Upload, rename,
delete group-scoped images; changes are immediately available to every dealer in the group.

## Security (must hold)
- A dealer can **never** see or use another dealer's images.
- Group images are visible only within that group.
- Enforce on **both** the API (via `getJwtClaims` — don't trust client-supplied scope/ids)
  and RLS. This is the same care as the group-scoping fixes earlier this session.

## Verify
- As a dealer: upload an image in the Builder background picker → it appears under **My
  Images**, usable on the canvas, and is **not** visible to any other dealer.
- As a group_admin: add an image to the **Group library** → every dealer in that group sees
  it under the group section; dealers outside the group do not.
- Platform images still show for everyone; super_admin upload still works.
- A dealer cannot delete platform or group images; can delete their own.
- Stop for review before deploy.
