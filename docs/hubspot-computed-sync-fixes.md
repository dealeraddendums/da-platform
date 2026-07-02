# HubSpot computed-sync fast-follows — 1000-row cap + lifecyclestage backward-move

> For Claude Code. Owner: Allan. Created 2026-06-10. Surfaced by CC during #116. **Writes to the
> live CRM — STOP for review.** Two real bugs in `POST /api/cron/sync-hubspot-computed` /
> `lib/sync-hubspot.ts`.

## Bug 1 — 1000-row cap (the bigger one)
The daily computed-sync processes only the **first 1,000 of 2,028 dealers** — an unpaginated
Supabase query hits the default 1000-row cap. So **~half the fleet's computed HubSpot fields**
(`prints_last_30`, `prints_last_12mo`, `dealers_in_group`) and the **Trial→Trial-Expired
re-evaluation** silently never refresh. **Fix:** paginate the dealer scan (range loop, 1000/page) —
mirror the pattern in `scripts/backfill-hubspot.mjs` and `da-legacy-etl runner.getActiveDealers`,
both of which already paginate past 1000. Verify it now processes all ~2,028.

## Bug 2 — lifecyclestage doesn't move on conversion (backward-move gap)
The sync sets `hs_lifecyclestage` directly, but HubSpot won't move a record to an *earlier-ordered*
stage without an explicit clear — so a **Trial-Expired / Free → Customer** conversion may not stick
(the stage stays put). This is exactly **AutoNation's** case (it was `Free`, now `Automatic Web`,
needs to land at **Customer**). **Fix:** when the derived stage is "below" the record's current
HubSpot stage, **clear `hs_lifecyclestage` (set empty) then set the target** in the same/sequenced
update (HubSpot's documented backward-move approach). Apply on both the event-driven write path and
the computed cron.

## AutoNation relevance
The cron trigger we just ran likely did **not** move AutoNation to Customer — both bugs work against
it (it may be beyond row 1000, and Trial-Expired/Free→Customer is the backward-move case). So
**AutoNation's HubSpot stage is the verification target for Bug 2**: after the clear-then-set fix
runs (cron or per-dealer manual sync), confirm its Company `lifecyclestage = Customer`. Until then,
its platform data is correct (`account_type=Automatic Web`, `converted_at` set) — only HubSpot lags.

## Verify
- Bug 1: a full computed-sync run processes all ~2,028 dealers (log the count); spot-check a dealer
  that was beyond row 1000 now has fresh `prints_last_30`.
- Bug 2: **AutoNation → `lifecyclestage = Customer`**; and a fresh Trial→paid conversion moves to
  Customer (not stuck). No dealer wrongly moved backward in normal operation.
- STOP for review before deploy (live CRM writes).
