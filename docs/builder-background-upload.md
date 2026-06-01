# Feature — Builder background-image upload (replace "Load from URL")

> For Claude Code. Owner: Allan. 2026-06-01. Small UI wiring — the backend
> already exists, reuse it.

## Ask
In the Builder's **Background Image** panel, replace the "Or load from URL" field
(never used) with an **Upload** control so a super_admin can upload a custom
background — e.g. a full-sheet **landscape (11"×8.5") infosheet** background.

## Backend already exists — reuse, do NOT build
`POST /api/admin/image-library/upload` (super_admin only) takes FormData
`{ file, bucket }`, validates type + size, uploads to S3, tracks in `image_library`,
returns `{ url, key, id, display_name }`. **Both background buckets are already
allowed:** `new-addendum-backgrounds` (5 MB) and `new-infosheet-backgrounds`
(10 MB). Because it writes to the same bucket the picker reads, an upload also
shows up in the "Platform Backgrounds" picker afterward.

## Change 1 (the ask) — `components/builder/BuilderPage.tsx`, background panel (~lines 1463–1470)
Replace the "Or load from URL" label + `<input>` + "Load URL" button with an
**"Upload background"** button (super_admin only) plus a hidden
`<input type="file" accept="image/png,image/jpeg,image/webp">`. On file select:
- `POST /api/admin/image-library/upload` with FormData `file` + `bucket =
  isInfosheet ? 'new-infosheet-backgrounds' : 'new-addendum-backgrounds'`
  (same expression already used at ~line 1787).
- On `201` → `setBgUrl(json.url); setBgInputVal(json.url); isDirtyRef.current = true;`
- Show an "Uploading…" state; surface the route's 422s (wrong type / over-size)
  through the existing toast.
Leave the "Default" + "Choose Background" controls above it unchanged.

## Change 2 (nice-to-have) — upload inside the picker modal
`ImagePickerModal` (rendered at ~line 1786 for "Platform Backgrounds") can take an
`allowUpload` prop that adds an Upload button in the modal, posts to the same route
with the modal's `bucket`, then refreshes the list and selects the new image. If
`ImagePickerModal` is already shared with the admin Image Library and has upload,
just pass the flag. Optional — Change 1 alone satisfies the ask.

## Permissions
The upload route is **super_admin only**, which fits the use case (Allan is
super_admin, ghosting the dealer). Gate the Upload button to super_admin so dealer
logins don't see a control that would 403. **If dealers should upload their own
backgrounds later, that's a separate feature** — those must go to a per-dealer
location, not the shared platform buckets (else every dealer's upload appears in
everyone's picker). Flagged; out of scope here.

## Notes
- This only adds the upload + sets `bgUrl`. Landscape (11"×8.5") rendering is
  existing canvas/paperSize behavior — if a landscape background renders wrong
  after upload, that's a separate canvas bug, not this feature.
- Don't touch the pixel-perfect widget canvas — this is confined to the background
  panel.

## Verify
- As super_admin ghosting a dealer, on a landscape infosheet template: Upload a
  landscape PNG → it becomes the canvas background and Save Template persists
  `bgUrl`; re-opening "Choose Background" shows the upload in the list.
- A dealer_admin building a template does NOT see the Upload button.
- Over-size / wrong-type file → friendly error, no crash.
