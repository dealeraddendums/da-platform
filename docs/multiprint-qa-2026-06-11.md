# Multiprint QA fixes — 2026-06-11 (post-print refresh + count distinct vehicles)

> For Claude Code. Owner: Allan. da-platform only (V5.0). Surfaced in Allan's QA pass.
> **Issue B is billing/print-gating sensitive AND currently blocking a live print — STOP for review
> before deploy.** Issue B's count change is the priority (it's wrongly blocking printing). Deploy via
> the V5.0 zero-downtime deploy. Migration: only if you take the RPC option in Issue B (see below).

---

## Issue A — bulk-print doesn't refresh print status until a manual page reload

**Symptom:** After selecting vehicles → Print Now → Send to Printer → close, the green "printed" state
(and the dashboard cards) don't update until the page is manually refreshed.

**Root cause (`components/ManualVehicleInventory.tsx`):** The bulk modal is rendered (~`:740`) as:
```tsx
{bulkModal && (
  <PrintPreviewModal … preloadedUrl={bulkModal.url}
    onClose={() => setBulkModal(null)} />   // ← no onPrinted; close just nulls the modal
)}
```
`PrintPreviewModal` already exposes `onPrinted?` (prop `:12`, fired after generation `:117`), but the
bulk caller passes **no `onPrinted`** and its `onClose` only does `setBulkModal(null)` — so nothing
re-reads print status. Compare the siblings in the same file: `clearPrintHistoryForSelection` does
`window.location.reload()` (`:327`, with a comment noting the parent dashboard cards are server-rendered)
and `confirmBulkDelete` does `fetchVehicles()` (`:347`). Bulk print was never given either.

**Fix:** On bulk-print completion, refresh **both** the inventory rows and the parent dashboard cards
(Printed This Month / Unprinted are rendered by the server `dashboard/page.tsx`, not this component):
- Add `onPrinted` to mark a "printed happened" flag, and on the bulk modal's `onClose` (or directly in
  `onPrinted`) call **`router.refresh()`** (re-runs the server component → refreshes the cards) **+
  `fetchVehicles()`** (refreshes the rows / green buttons). This avoids the full white-flash of
  `window.location.reload()`. (If simpler/consistent is preferred, `window.location.reload()` matches
  the existing clear-history path and is acceptable given low traffic.)
- **Timing caveat:** the print flags + `print_history` land via the **fire-and-forget `logGeneratePdf`**
  pipeline (see CLAUDE-da-platform.md Phase 10b) that runs alongside the async PDF job. Refresh on modal
  **close** (not the instant the preview renders) so the background write has landed; verify the
  refreshed list shows the new green state. If it still races, refresh after the job status reports done.
- **Also check the single-vehicle path** (`PrintNowBtn`, `:571`) — give it the same refresh so a single
  Print Now also greens immediately. Confirm in QA.

No migration.

---

## Issue B — print totals count PDFs/events, not vehicles → wrongly blocks the trial cap

**Symptom:** Printed the same 15-vehicle batch 2–3× (~36 sends). Only 15 distinct vehicles, but printing
is now blocked as "trial limit reached." Allan: **"only count vehicles, not PDFs generated."**

**Root cause:** The trial cap counts **rows** in `print_history`, and a row is inserted **per vehicle
per PDF generation** — every time the bulk modal opens, not just on a real send:
- Count: `lib/print-eligibility.ts:187–190` — `from("print_history").select("id",{count:'exact',head:true}).eq("dealer_id",…)` → `lifetime_prints`, fed to the 30-print cap (`TRIAL_PRINTS_CAP`).
- Insert per generation: `app/api/pdf/bulk/route.ts:68` (one per vehicle), `app/api/pdf/generate/route.ts:43`, `buyers-guide/route.ts:135` — driven by `PrintPreviewModal`'s generate-on-open (`:117`).
- So 15 vehicles × ~2.4 generations ≈ 36 rows → `lifetime_prints`=36 > 30 → `canPrint` returns
  `trial_expired`. Distinct vehicles = 15.

The dealer **dashboard cards are already vehicle-based and correct** (`dashboard/page.tsx:144` counts
`dealer_vehicles.print_status`). The bug is confined to **`print_history` row-counts**, which feed:
1. **Trial cap (MUST FIX — this is the block):** `print-eligibility.ts:187` (`canPrintForDealer`).
2. **Billing trial progress (MUST FIX — same source, shown to the dealer):** `app/api/billing/me/route.ts:159–162` (and the copy in `docs/billing-free-card-trial-copy.md` → `trialPrintN`).
3. **HubSpot `prints_last_30` / `prints_last_12mo` (recommend, for consistency):** `lib/sync-hubspot.ts:298–306`, `app/api/cron/sync-hubspot-computed/route.ts:98/114`, `dealers/route.ts:150–151` (`last30`).
4. **super_admin / group "addendums this month" (recommend):** `dashboard/page.tsx:304–305` and `:383–387`.

**Fix — count DISTINCT `vehicle_id`, not rows.** `print_history` has `vehicle_id` (text, migr. 030;
indexed). Keep logging every event (the per-vehicle **History** feature relies on it) — only the
**counts** change to distinct vehicles.

Preferred (one shared, efficient mechanism): add a small SQL function and use it everywhere a count is
needed —
```sql
-- new migration (apply via Supabase SQL editor, then deploy the code that calls it)
CREATE OR REPLACE FUNCTION public.printed_vehicle_count(
  p_dealer_id text, p_since timestamptz DEFAULT NULL
) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT count(DISTINCT vehicle_id)::int
  FROM public.print_history
  WHERE dealer_id = p_dealer_id
    AND (p_since IS NULL OR created_at >= p_since);
$$;
```
Call via `admin.rpc('printed_vehicle_count', { p_dealer_id, p_since })` — `p_since` null = lifetime cap,
30d = `prints_last_30`, 12mo = `prints_last_12mo`, start-of-month = the super_admin/group card.
- In `canPrintForDealer`, also **guard the count behind `isTrialAccountType(account_type)`** — paid
  dealers don't need it (skip the query entirely).
- **Migration-free alternative for the MUST-FIX only** (if you want to unblock before applying DDL):
  in `canPrintForDealer` + `billing/me`, fetch `.select("vehicle_id").eq("dealer_id",…)` and use
  `new Set(rows.map(r=>r.vehicle_id)).size`. Trial `print_history` is small, and it's gated to trial
  accounts, so it's cheap. Use the RPC for the fleet-scale counters (#3/#4).

**Remediation — self-healing, no data surgery.** Once the cap counts distinct vehicles, the blocked QA
dealer recomputes to 15 ≤ 30 and **unblocks on deploy**. **Do NOT delete `print_history`** to "fix" it
(that would erase real history). Note: **any** trial dealer who reprinted is currently over-counted and
wrongly gated — this fix unblocks them all, so it's worth shipping promptly.

**Secondary (flag, Allan's call — don't bundle):** `print_history` logs a row on every PDF *generation*
(modal open), so even a preview that's cancelled records "prints." The distinct-vehicle count makes this
harmless for the cap, but it still pollutes the per-vehicle History and event-based metrics. Optional
follow-up: record the print on actual **Send/Download** rather than on generate, or dedupe the log.
Leave as a separate item.

---

## Verify
- **Issue A:** Select ≥2 vehicles → Print Now → Send to Printer → close: the rows turn green **and**
  "Printed This Month" updates **without a manual reload**. Single-vehicle Print Now greens immediately
  too. Confirm the refresh fires after the print flags have been written (no race).
- **Issue B:** Reprint the same batch several times → distinct-vehicle count stays = number of distinct
  vehicles; trial cap reflects vehicles, not generations. The blocked QA dealer can print again after
  deploy (count = 15). A trial dealer printing 30 *different* vehicles still hits the cap correctly.
  Billing trial progress shows the vehicle count. (If applying #3/#4: HubSpot/superadmin monthly now
  count distinct vehicles — expect lower, more accurate numbers.)
- **STOP for review before deploy** (print-gating + billing sensitive). Migration only if you take the
  RPC option — apply via the Supabase SQL editor first, then deploy.
