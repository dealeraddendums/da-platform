# Asking Price widget — optional symbol after the price ($39,999*)

> For Claude Code. Owner: Allan. Created 2026-06-10. Builder change; **no migration** (widget data
> lives in `template_json`). Ship in the training-fixes batch.

## Ask
Let the dealer put an optional symbol — `*`, `**`, `†`, etc. — **after the asking price**, e.g.
`$39,999*` (typically to tie the price to a footnote/disclaimer they place elsewhere).

## Change
1. **Render — `components/builder/widgetRenderer.ts`, the `askbar` block (~line 170).** The price is
   rendered as `${d.value}` inside the value `<span>`. Append the suffix **inside that same span**, so
   it inherits the price's color/size/weight:
   ```
   …text-align:right;…">${d.value}${(d.priceSuffix as string) || ''}</div>
   ```
2. **Config — `components/builder/BuilderPage.tsx`, the `askbar` config block (~line 2075).** Add a
   short free-text input **"Symbol after price"** that sets `d.priceSuffix` (1–3 chars; e.g. `*`).
   Default **empty** → no suffix (existing templates unchanged).
3. **Storage:** `priceSuffix` is just another key on the widget's `d` bag in `template_json` — **no
   migration, no schema change.**

## Verify
- Set the field to `*` → the **printed addendum + infosheet** asking price reads `$39,999*`, and the
  `*` matches the price's color/size (it's in the same span).
- Empty field → no suffix; existing templates render exactly as before.
- The suffix shows in the Builder canvas preview too (same `renderW`).
- STOP for review.
