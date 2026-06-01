# HubSpot duplicate-company cleanup + recurrence guard

> For Claude Code. Owner: Allan. claude.ai session 2026-05-31.
> **Destructive (HubSpot merges are irreversible) — dry-run + review before --apply.**
> Run this BEFORE the realtime/Downgraded/archive + manual-sync-tab work.

## Root cause (confirmed)
The backfill/sync matches a dealer's company in 3 stages: PATCH stored
`hubspot_company_id` → search `companies` by **`platformid` = dealer slug** →
**create**. Dealers with no stored id whose pre-existing company **lacks
`platformid`** (created manually or by the now-**abandoned** legacy HubSpot/Intercom
sync) miss both match stages → a bare "No owner" duplicate gets created, and its id
is written back to the dealer row — orphaning the real record (owner, logo,
activity). The backfill ran across ~1,600 dealers, so expect **many** pairs.

## Scale, scope & side-effects (the backfill ran across ALL dealers yesterday)

**Measured 2026-05-31 (`hubspot-dup-count.mjs`, read-only):** 3,611 companies ·
**224 duplicate name-clusters** = **163 sync-created** (platformid + non-platformid
together — our dups, the auto-merge target) + **61 pre-existing** (no platformid
involved; predate our work — handle as a separate manual pass). ~241 excess
records; ~17 clusters have 3+ records → route those to manual review.
**Contacts: 0 dup clusters across 8,781 — clean, no contact cleanup needed.**
The dealer-driven merge script naturally targets only the 163 (it starts from our
`platformid` record); the 61 pre-existing won't be touched by it.

- **Companies, not contacts.** Contacts match by `email`, which HubSpot enforces
  as unique (create → 409 → PATCH), so duplicate *contacts* should be ~0 — confirm
  with a count, but the dup blast is **companies**: both **dealers and groups**
  (groups have the identical gap — the `groupid` search misses originals that lack
  it). The script must cover companies created for both.
- **Quantify first.** The dry-run must print a **total count** (dealer pairs +
  group pairs + REVIEW count) before any merge, so we know the blast radius.
- **⚠️ Workflow side-effects.** The dups were created with `lifecyclestage` set, so
  Alex's HubSpot workflows may have **enrolled the duplicate companies** (and
  possibly sent onboarding emails / created tasks). Merging consolidates the
  records + associations but cannot un-send what already fired. **Before running
  the cleanup, loop in Alex to pause the affected workflows and review
  enrollments;** flag in the dry-run any dup that already has workflow enrollment
  or activity.

## Stop the bleeding
- The backfill was the blast and is **one-time — do not re-run it.** Most dealers
  now carry a stored `hubspot_company_id` (even if pointing at a dup), so ongoing
  *new* dup creation is low-volume (only edits to still-unlinked dealers).
- Ship the **Part 2 guard** (skip-create + alert) before the realtime/archive +
  tab work so no fresh dups accrue while you clean up. A temporary
  `HUBSPOT_SYNC_PAUSED` flag on the route is an optional extra brake (don't unset
  `HUBSPOT_PRIVATE_APP_TOKEN` — the dedup script needs it).

## Decisions (locked)
- **Match key stays `platformid`.** `dealerid` (= `inventory_dealer_id`) changes
  with the feed supplier, so it's never a match key. No code change to the matching
  logic.
- **Legacy HubSpot/Intercom sync is dead** — originals are static, no ongoing dup
  source.
- **Survivor = the original** (owner / logo / activity / associations). The bare
  sync-created dup merges *into* it.

## Part 1 — one-time dedup/merge script (`scripts/hubspot-dedup.mjs`)
Dry-run by default; `--apply` to act. Pattern + env-loading like
`backfill-hubspot.mjs`.

For each **active dealer**:
1. Identify **our record** = the company at `dealers.hubspot_company_id` (or the
   `platformid = dealer.dealer_id` hit). Skip the dealer if it has no `platformid`
   company at all (nothing we created).
2. Find the **original**: search `companies` by `name = dealer.name`; keep hits with
   a **different id that lacks `platformid`**. Confirm it's a true pair —
   **exact name AND matching phone** (and/or state). 
   - Exactly one confident original → it's a pair.
   - Zero → dealer's company is the only one (a legit create) — skip.
   - More than one, or name/phone mismatch → **don't merge; log to a
     `needs-manual-review` list.**
3. **Merge** (only with `--apply`, only on confident pairs):
   `POST /crm/v3/objects/companies/merge` with `{ primaryObjectId: original.id,
   objectIdToMerge: ourDup.id }` (confirm payload against current HubSpot docs).
   Primary (original) keeps its id, owner, activity, associations; the dup's data
   fills blanks then the dup is retired.
4. **Re-point + refresh:** set `dealers.hubspot_company_id = original.id`, then run
   the normal `syncDealerToHubspot(dealer)` so all DA-owned props (incl.
   `platformid`, the four IDs, subscription_type, lifecyclestage) land on the
   survivor. Now `platformid` is stamped → future syncs match by it.

Dry-run output: one line per dealer — `dealer_id | our_dup_id | original_id |
name | original_owner | action(MERGE/SKIP/REVIEW)` + totals. Review the MERGE and
REVIEW lists before `--apply`. Pace ~20 req/s like the backfill.

## Part 2 — stop new dups (recurrence guard)
Even after cleanup, a not-yet-synced dealer with an unlinked original would re-dup
on its next sync. Add a guard in `lib/sync-hubspot.ts` `syncDealerToHubspot`,
**before the stage-3 create**: if the dealer has no stored id AND a `companies`
search by `name` (exact) + phone returns a hit **without `platformid`**, do NOT
create — log to `hubspot_sync_errors` (op `"dedup-skip"`) and Mandrill-alert so a
human links it. Genuinely-new dealers (no name match) still create normally. This
keeps the platformid-only rule while refusing to manufacture a known duplicate.

## Sequencing
Run **Part 1 (dry-run → review → apply)** and ship **Part 2** *before* the
realtime/Downgraded/archive build and the manual-sync tab — otherwise that work
adds sync activity on top of the current dup-prone state.

## Verify
- Dry-run: spot-check 5–10 MERGE lines against HubSpot — confirm each "original"
  is the real owner-bearing record and the dup is the bare today-created one.
- After apply on a test pair: one company remains, it has the owner + activity +
  `platformid`, and `dealers.hubspot_company_id` points to it; the dealer page's
  HubSpot link opens the surviving record.
- REVIEW list is short and genuinely ambiguous (handle by hand / HubSpot Manage
  Duplicates).
- Guard: create a throwaway dealer whose name matches an existing company → sync
  skips create + alerts instead of duping.

## Confirms (defaults chosen — flag if wrong)
1. Survivor = original (owner-bearing). [default]
2. Pairing key for the one-time cleanup = exact name + phone. [default; widen/narrow
   if it's over- or under-matching in the dry-run]
3. Build the Part 2 guard now (recommended), or rely on cleanup + careful re-sync only?
