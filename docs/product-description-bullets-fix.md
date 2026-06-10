# Fix — bullets / lists stripped from product descriptions

> For Claude Code. Owner: Allan. Created 2026-06-10. da-platform only; no migration.

## Bug
A bulleted description (e.g. one / two / three) renders correctly in the **Configure Product**
editor, but saves and prints as **"onetwothree"** — bullets and line breaks collapsed into a
run-on. Seen in the Addendum Details row **and** the printed addendum.

## Root cause
`lib/product-name.tsx` → `sanitizeProductHtml` allowlist:
```
ALLOWED_TAGS = ["span","b","strong","i","em","u","br","sub","sup","img"]
```
**No `ul`/`ol`/`li`/`p`.** DOMPurify drops those tags and keeps their text nodes → the `<li>`
contents concatenate. This sanitizer was built for product **names** (inline-only); the
**description** render sites reuse it (`components/AddendumEditor.tsx` on-screen +
`components/builder/widgetRenderer.ts` for the PDF), so list/paragraph markup is stripped.

**Second gap — `font-size` is also stripped.** `ALLOWED_STYLE_PROPS` =
{color, font-weight, font-style, text-decoration, background-color} — **no `font-size`**, so the
editor's **Size** control is silently dropped ("Larger" prints at normal size). Bold and color
survive because `<strong>`/`<b>` are allowed tags and `color` is an allowed prop. Net: the
sanitizer's allowlist **lags the editor's capabilities** on two axes (block/list tags + font-size).

## Fix
1. **Add a description-specific allowlist** in `lib/product-name.tsx` —
   `sanitizeProductDescription(raw)` = `ALLOWED_TAGS` **+ `["ul","ol","li","p"]`** (block/list
   tags). **Keep `sanitizeProductHtml` (the NAME sanitizer) tight/inline** — a product name
   shouldn't carry block/list tags. (`KEEP_CONTENT:true` is why stripped `<li>`s collapse to run-on
   text — allowing the tags fixes it.)
   **Also add `font-size` to `ALLOWED_STYLE_PROPS`** (it's currently missing, so the Size control is
   dropped) — plus whatever the **indent/align** controls emit (likely `text-align` and/or
   `margin-left`/`padding-left` — confirm against a real stored description and add what's actually
   produced). Keep the existing `url()`/`expression`/`javascript:` rejection. (Style props are shared
   name+description — harmless on names.) **Principle: the allowlist should match everything the
   editor can author, and nothing more.**
2. **Point the description render sites at it:** `AddendumEditor.tsx` and the description widget in
   `widgetRenderer.ts` call `sanitizeProductDescription` (not the name sanitizer).
3. **Render CSS check:** confirm the description block actually *shows* bullets — `ul { list-style:
   disc; padding-left: … }` (and `ol { list-style: decimal }`) and that a global print/reset CSS
   isn't zeroing `list-style`/padding. (The symptom is total collapse, which points at stripping —
   but once the tags survive, verify the • markers + indent render in the **PDF**, not just on screen.)
4. **Save-path check:** confirm sanitization is **render-time** (the stored description still
   contains `<ul>…`) so existing descriptions recover automatically once the renderer allows lists.
   If a **save path** also over-sanitizes (flattens on write), fix it there too — and note that
   already-flattened descriptions can't be recovered (dealer re-enters).

## Verify
- A one/two/three bulleted description shows as a **real bulleted list** in: the Configure Product
  preview, the **Addendum Details** row, and the **printed addendum + infosheet**.
- **Numbered lists** and **paragraph breaks** survive too; **bold / italic / underline / size /
  color** still work.
- A malicious payload (`<script>`, `onerror=`, `javascript:`) is **still stripped** (allowlist
  intact — we only added list/paragraph tags).
- STOP for review.
