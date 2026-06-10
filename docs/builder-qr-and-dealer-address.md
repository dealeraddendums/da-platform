# Builder fixes — QR transparent background + dealer-address source-of-truth

> For Claude Code. Owner: Allan. Created 2026-06-07. Two small, separate Builder fixes.

## 1. QR code: transparent background (not white)
`components/builder/widgetRenderer.ts` (qrcode widget, ~line 301) is white on two counts:
- the container `<div>` has **`background:#fff`**, and
- the QR **image** is opaque white — both the canvas-preview fallback
  (`api.qrserver.com/...` returns a white-bg PNG) and the PDF-time pre-generated base64
  (`d.imgUrl`) bake in a white background.

**Fix:**
- Remove `background:#fff` from the QR widget container (→ transparent) so the addendum
  background shows through behind the code.
- Generate the QR **dark-on-transparent** (alpha light color) for **both** paths — the
  PDF-render base64 (the path that sets `d.imgUrl`) and the canvas preview. Use a QR lib that
  supports a transparent light color (e.g. the `qrcode` npm lib, `color.light = '#00000000'`)
  instead of qrserver's opaque PNG. Bonus: this drops the external `api.qrserver.com` dependency
  (and its CSP `connect-src` entry).
- Keep the dark modules dark + an adequate quiet zone so it still scans; transparent is fine
  where the area behind it is light (the addendum's QR area is white).

**Verify:** the QR on a printed addendum/infosheet has a transparent background (no white box;
the background/whitespace shows through) **and still scans**.

## 2. Dealer address: edit at the source (My Profile); Builder widget reflect-only
**Root cause of "Save doesn't keep my edited dealer address":** the Builder dealer-address
widget's text is **auto-derived from the dealer record** on every load / vehicle-bind
(`applyDealerInfoToWidgets`, BuilderPage ~line 177; the vehicle-bind branch ~line 215), so a
manual edit in the Builder is silently overwritten. The address (including the "Eastsou**d**"
typo) lives in `dealers.address/city/state/zip`.

**Source of truth already exists:** `ProfileClient.tsx` (My Profile) edits
address/city/state/zip (+ contact/phone), gated by `canEdit`. Editing there flows to the
auto-derived widget **and every print**.

**Fix (recommended — one source of truth):**
1. Make the Builder dealer-address widget **reflect-only for its TEXT** — don't present an
   editable text box that gets clobbered. Keep position/size/font/alignment editable; add a
   small hint: *"Address is set in My Profile."* Removes the data-loss dead-end.
2. Ensure My Profile's address is **editable for a group_admin switched into the dealer**
   (parity) — confirm `ProfileClient` `canEdit` is true for group_admin-with-active-dealer (it
   already is for dealer_admin/super_admin), so the operator can correct it at the source.
3. No per-template override — the widget re-derives at render, so a My-Profile edit
   propagates to all templates automatically. *(Alternative if you'd rather: make the widget a
   persisted per-template override — but that's two sources of truth and leaves the real
   address wrong elsewhere; not recommended for an address-typo fix.)*

**Verify:** correct the address in My Profile (as dealer_admin / group_admin-as-dealer /
super_admin) → it shows on the addendum + the widget; the Builder widget reflects it and no
longer offers a silent-loss text edit; "Eastsoud" → "Eastsound" fixes everywhere at once.

## (Both)
- Stop for review before deploy. The QR change is rendering-only; the address change touches the
  Builder widget panel + (a parity confirm on) My Profile edit.
