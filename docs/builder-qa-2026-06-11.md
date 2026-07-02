# Builder QA fixes — 2026-06-11 (Dealer Address + drag-stick + select-placed-tile)

> For Claude Code. Owner: Allan. da-platform only (V5.0). **All client-side in the Builder — NO
> migration, no schema/API change.** Surfaced in Allan's QA pass. **STOP for review before deploy**
> (Builder is pixel-perfect / ground-truthed by Allan). Deploy via the V5.0 zero-downtime deploy.

All three live in `components/builder/BuilderPage.tsx` (Issue 1 also touches the render allowlist in
`components/builder/widgetRenderer.ts`).

---

## Issue 1 — Dealer Address edits don't stick → make the field READ-ONLY (pull from profile)

**Symptom:** Typing a new address in the Dealer Address widget's box doesn't persist — it reverts on
reopen.

**Root cause (not a save bug — by design):** The `dealer` widget renders `d.text`
(`widgetRenderer.ts:173–177`), and the panel textarea edits `d.text` live + `saveTemplate` does
persist it (`BuilderPage.tsx:2093`, `:1017`). **But every load path re-derives `d.text` from the
active dealer's profile/vehicle data and overwrites it** — `applyVehicleDataToWidgets` (`:215–222`,
called at `:643/:777/:816/:866/:1148/:1188`) and `applyDealerInfoToWidgets` (`:186–188`, the
blank-builder path). This is the intended **source-of-truth** behavior (so a group template shows
each member dealer's own address). So the typed override is always clobbered.

**Decision (Allan, 2026-06-11): keep source-of-truth; make the box read-only.** Don't add an
override path. Make the UI honest.

**Fix — the `w.type === 'dealer'` config block (`BuilderPage.tsx:2090–2106`):**
1. Replace the editable `<textarea value={(d.text)} onChange={e => u('text', …)} />` with a
   **read-only** display of the current `d.text` (the profile-sourced address) — e.g. a `readOnly`
   textarea (or styled div) with muted styling and `cursor:default`, preserving line breaks.
2. Add a hint line beneath it: **"Address comes from your profile — edit it in My Profile,"** with a
   link to the My Profile page (`/profile` — confirm route; that's the Nav "My Profile" target). If
   `d.text` is empty, show **"No address on file — add it in My Profile."**
3. **Keep** the Alignment control and the shared Font-size / Line-spacing / Position controls — those
   are layout, not address content, and stay editable.
4. **Do NOT change** `applyVehicleDataToWidgets` / `applyDealerInfoToWidgets` — the populate-on-load
   is now correct and intended.

No migration. Existing templates already store a populated `d.text`; it'll keep refreshing from the
profile as it does today.

---

## Issue 2 — clicking a widget makes it "stick" to the cursor

**Symptom:** Clicking the Address box (and widgets generally) can grab the widget so it follows the
cursor and is hard to drop.

**Root cause:** `startMove` (`BuilderPage.tsx:512`) arms `dragRef` into move mode on **mousedown
with no movement threshold**, and the drag ends only via a **`document` `mouseup`** (`:580`, effect
`:543–594`). So (a) a plain click — or a trackpad tap with 1–2px drift — enters move mode, and (b) if
the release isn't delivered to `document` (mouse released outside the paper/window), `dragRef` stays
set and the widget keeps following the cursor until the next click. There's no pointer capture and no
`pointercancel`/window-level safety net.

**Fix (robust, root-cause-agnostic — please reproduce first to confirm the trigger):**
1. **Add a drag threshold.** On mousedown, store the pending start (id, start client x/y, offsets)
   and `setSelId(id)`, but **don't treat it as an active move until the pointer moves > ~3–4px**. A
   pure click then only selects — it can never start a drag. Only push history when an actual move
   occurred (no history entry for a no-move click).
2. **Make release bulletproof.** Prefer **Pointer Events**: on the widget, `onPointerDown` →
   `el.setPointerCapture(e.pointerId)`; handle `pointermove` / `pointerup` / `pointercancel`; on
   up/cancel `releasePointerCapture` + clear drag. Pointer capture guarantees the up event targets the
   widget even if the cursor leaves the paper/window. (If you keep mouse events instead, at minimum
   bind `mouseup` on `window` and also clear drag state on `pointercancel` / `blur`.)
3. Keep `startResize` consistent with whatever model you choose.

**Verify the trigger before/after:** reproduce the stick (try a small drag that releases off the
paper / outside the window), confirm the fix, then confirm a click selects without dragging and every
drag releases cleanly.

---

## Issue 3 — let greyed-out (already-placed) palette tiles be clicked to SELECT the widget

**Ask:** Clicking a greyed-out widget tile should select that widget on the template.

**Today (`BuilderPage.tsx:1375–1396`):** A tile is `used` when it's a single-instance widget
(`UNIQUE_WIDGETS`) already on the canvas; used tiles are greyed (`opacity:.22`, `grayscale(1)`) and
**inert** (`pointerEvents:'none'`, `onClick` gated by `!used`, `draggable={!used}`).

**Fix:**
1. Remove `pointerEvents:'none'` for used tiles (keep `draggable={!used}` so you still can't drag a
   second copy).
2. `onClick`: `used ? selectPlacedWidget(tile.type) : addWidget(tile.type)`.
3. `selectPlacedWidget(type)`: find the widget id in `widgets` whose `.type === type` (single-instance
   ⇒ exactly one) and `setSelId(id)`. Optional nicety: scroll it into view / brief highlight.
4. Polish for used tiles: `cursor:'pointer'`, bump `opacity` from `0.22` → ~`0.4` so they read as
   clickable (not disabled), and update the tile hint to e.g. "Placed — click to select."

Only `UNIQUE_WIDGETS` are ever greyed, so this only affects single-instance widgets — exactly the
"select the one that's already there" behavior. Multi-instance tiles are unchanged.

---

## Verify (all)
- **Issue 1:** Dealer Address box is **read-only** and shows the profile address; editing My Profile
  changes what the widget shows; Alignment / font-size / position still work; a **group** template
  shows each member dealer's own address. Empty profile → the "add it in My Profile" hint.
- **Issue 2:** A click on any widget (incl. the Address box) **selects without sticking**; dragging
  moves it and it **releases on every mouseup**, including when released **outside the paper/window**;
  no accidental move on a plain click.
- **Issue 3:** Clicking a greyed-out (already-placed) tile **selects** that widget on the canvas; you
  still **can't** add a duplicate; multi-instance tiles unchanged.
- **STOP for review before deploy.** No migration. Deploy via the V5.0 zero-downtime deploy.
