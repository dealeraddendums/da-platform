# Bug/feature — safe rich-text + image rendering for product names (and descriptions)

> For Claude Code. Owner: Allan. Created 2026-06-02 (expanded same day).
> Two related needs in product **names** (and, for safety/consistency, descriptions):
> 1. A name can contain a raw `<img …>` tag (a logo). The management UI prints the
>    raw tag as text, so you can't tell what the product is. Allan picked: show a
>    **thumbnail + readable label**.
> 2. A name/description should support **inline formatting** like
>    `3<span style="color:red">M</span> Window Tint` and render correctly everywhere
>    (the "M" red), not show the raw `<span>` tag.
> Same fix for both: render product names through a **sanitized rich-text renderer**
> instead of plain text, and route descriptions through the same sanitizer.

## Current behavior
- **Insert:** `components/OptionsLibrary.tsx` ImagePicker `onSelect` (~528–531)
  builds `` `<img src="${url}" width="125" style="max-width:125px;" />` `` (no `alt`)
  and appends to the name/description. Same img-insert likely in
  `components/CorporateProductModal.tsx`.
- **Names render as plain text** in the Addendum Products table (options page), the
  "Add from Library" modal, the Configure Product ITEM NAME field, and the
  `AddendumEditor` product rows → raw `<img>` / `<span>` tags show as code.
- **Descriptions** already render via `dangerouslySetInnerHTML` (`AddendumEditor`
  ~542) — inline styling already works there, but it's **unsanitized** (XSS risk).
- The printed addendum (PDF) already renders names as HTML (that's why a logo in a
  name prints) — confirm during build; the span styling should already print. This
  change targets the **management UI** + adds sanitization everywhere.

## Part 1 — attach an `alt` on image insert
- Include an `alt` when inserting an image:
  `` `<img src="${url}" alt="${alt}" width="125" style="max-width:125px;" />` ``.
  Default `alt` = filename-derived label (decode, strip path+ext, `_`/`-`→space,
  collapse/trim, drop a leading all-digits token). Add a small editable
  **"Label (alt text)"** input to `ImagePickerModal`, pre-filled. Apply in
  OptionsLibrary + CorporateProductModal.

## Part 2 — sanitized rich-text renderer for names
- **Add an HTML sanitizer** (none in the repo today): `isomorphic-dompurify`, or a
  tight allowlist sanitizer. Allowlist:
  - Tags: `span, b, strong, i, em, u, br, sub, sup, img`.
  - `style` limited to `color, font-weight, font-style, text-decoration`; on `img`:
    `src, alt, width, style(max-width/max-height)` only.
  - Strip everything else (script, event handlers, etc.). Only allow `img` `src`
    that is `https:` (ideally the `addendum-product-images` / `dealer-addendums` S3 hosts).
- New `lib/product-name.tsx`:
  - `parseProductName(raw)` → `{ hasImage, imageUrl, alt, label }`
    (`label = alt || filenameLabel(src) || "Product image"`).
  - `<RichName name={raw} imgMaxH?={px} showLabel?={bool} />` — renders the
    **sanitized** HTML via `dangerouslySetInnerHTML` inside a wrapper that CSS-
    constrains `img { max-height: imgMaxH; width: auto; vertical-align: middle }`.
    When the name has an `<img>` and `showLabel`, also render the `label` text
    beside it (keeps list/table rows scannable); set wrapper `title={label}`.
- Use `<RichName>` at every name-display site:
  - Addendum Products table PRODUCT NAME cell — `imgMaxH≈24`, `showLabel`.
  - "Add from Library" modal list — `imgMaxH≈20`, `showLabel`.
  - `AddendumEditor` product-row name — `imgMaxH≈28`.
  - Configure Product modal: keep the raw value in the ITEM NAME **text input**
    (editable) and show a `<RichName>` **preview** beneath it (`imgMaxH≈40`, `showLabel`).
- Plain-text and inline-formatted names (the 3M example) render correctly via the
  same path — the span renders; no img → no thumbnail/label.

## Part 3 — harden descriptions
- Route the existing description `dangerouslySetInnerHTML` (AddendumEditor ~542 and
  any other description render sites) through the **same sanitizer**, so inline
  styling keeps working and arbitrary HTML can't execute.

## Notes
- Existing rows (no alt) → filename fallback; no backfill required.
- Never render unsanitized name/description HTML anywhere.

## Verify
- `3<span style="color:red">M</span> Window Tint` shows as **3M Window Tint** with a
  red "M" — in the products table, library modal, addendum list, the Configure
  Product preview, AND on a test print.
- An `<img>`-name product shows a size-constrained logo thumbnail + readable label
  (not the raw tag) in all those places.
- A `<script>` / `onerror=` in a name or description is stripped (sanitizer test).
- Plain-text names unchanged. Stop for review before deploy.
