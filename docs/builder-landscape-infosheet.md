# Fix — custom sizes can be Addendum OR Infosheet (Option 2, chosen)

> For Claude Code. Owner: Allan. 2026-06-01.
> Chosen approach: give each **custom size its own document type**, so a custom
> size (e.g. a landscape 11"×8.5") can be an infosheet and surface the infosheet
> widgets + render correctly. (Option 1 — a single landscape-infosheet preset —
> was the simpler alternative; not chosen.)

## Root cause (confirmed)
"Infosheet" is hard-wired to one paper size: `isInfosheet = paperSize ===
'infosheet'` (`BuilderPage.tsx:1187`, and again at 359/410/784/927/1828/1483;
plus `effectivePaperSizeStr === 'infosheet'` in the PDF generate/bulk routes).
The palette hides `PALETTE_HIDDEN_IN_ADDENDUM = ['description','features']`
(constants.ts:97) when not-infosheet — and those two are the entire Infosheet
group — so a custom size (paperSize = a `dealer_custom_sizes` UUID) shows an empty
Infosheet section and addendum widgets instead. Fix = let a custom size declare
its type, and resolve `isInfosheet` from that type everywhere.

## 1. Data model
- **Migration** (check current max #): `ALTER TABLE dealer_custom_sizes ADD COLUMN
  doc_type text NOT NULL DEFAULT 'addendum'` (values `'addendum' | 'infosheet'`).
  Existing rows default to addendum — no behavior change for them.
- `lib/db.ts`: add `doc_type: 'addendum' | 'infosheet'` to `DealerCustomSizeRow`
  (~line 437) and to the `dealer_custom_sizes` Insert/Update types (~1531–1532).

## 2. API — `/api/custom-sizes`
- `route.ts` (POST) and `[id]/route.ts` (PATCH): accept + persist `doc_type`
  (default `'addendum'` when absent).

## 3. Create / manage UI
- `components/builder/AddCustomSizeModal.tsx`: add a **Document type** selector
  (Addendum / Infosheet); include `doc_type` in the POST body (~line 34).
- `components/CustomSizesModal.tsx`: add `doc_type` to `SizeItem` (line 7), the
  create/edit form + the POST/PATCH body (~line 56), and show it in the table.
  Editing matters — it lets Allan flip his **existing** custom size to Infosheet
  without recreating it.

## 4. Builder (`components/builder/BuilderPage.tsx`)
- Add `doc_type` to the `CustomSize` type (~line 235) and make sure the page that
  renders `<BuilderPage customSizes=…>` selects `doc_type` when it loads
  `dealer_custom_sizes`.
- Resolve infosheet from the selected size's type. Add a tiny helper and use it
  everywhere that currently tests `paperSize === 'infosheet'`:
  ```ts
  const resolveIsInfosheet = (ps, sizes) =>
    ps === 'infosheet' || sizes.find(c => c.id === ps)?.doc_type === 'infosheet';
  ```
  Apply at: line 1187 (palette gate), 359 + 1828 (background bucket), 410
  (`makeWidget`), 927 (preview docType), 1298 (`saveDocType` default), and the
  bg-default at 1483/1486. (Use `customSizesRef.current` like the existing
  `getPaperDims(ps, customSizesRef.current)` calls.)
- **Do NOT auto-load the portrait `LAYOUT_INFOSHEET`** for a custom infosheet size
  (its coords are 816×1056 portrait). In the switch-to-size handler (~784/813),
  keep the auto-layout only for the built-in `'infosheet'`; custom sizes start
  blank and the user places widgets (Allan is hand-building with an uploaded bg).

## 5. PDF render routes (the half that's easy to miss)
`app/api/pdf/generate/route.ts` and `app/api/pdf/bulk/route.ts` already query
`dealer_custom_sizes` for `width_in/height_in/background_url` when the paperSize is
a custom UUID (bulk ~line 441). **Add `doc_type` to that select** and set
`isInfosheet = effectivePaperSizeStr === 'infosheet' || customSize?.doc_type ===
'infosheet'`. Without this the widgets show in the builder but **print blank** —
the AI description/features fetch and the `new-infosheet-backgrounds` routing are
both gated on `isInfosheet` at render time.

## 6. Docs
Update `CLAUDE-da-platform.md`: note custom sizes carry `doc_type`, and add the
landscape infosheet to the "Document Types & Canvas Dimensions" table.

## Allan's current state
His existing custom size defaults to `addendum` after the migration. He flips it
to **Infosheet** in Manage Custom Sizes (step 3) — no recreate needed. (His earlier
background upload went to `new-addendum-backgrounds` under the old logic; still
reachable via Choose Background / URL, or re-upload once the size is infosheet and
it'll land in the infosheet bucket.)

## Verify
- Set a custom landscape size's type = Infosheet → Builder shows Description +
  Features, hides MSRP/Required Products/Subtotal/Suggested; canvas = the custom
  dims.
- Place Description + Features, Save, then **print** a vehicle on that template →
  they populate with AI/DB content (not placeholder); bg pulls from the infosheet
  bucket.
- A custom size left as Addendum behaves exactly as today; the built-in 8½″
  Infosheet is unchanged.
- Stop for review before deploy (touches a migration + the render routes).
