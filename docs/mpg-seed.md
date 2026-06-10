# One-time MPG seed — backfill `dealer_vehicles.cmpg`/`hmpg` from Aurora

> For Claude Code. Owner: Allan. Created 2026-06-07. The MPG fields shipped but **0 of ~1.5M
> `dealer_vehicles` rows** carry `cmpg`/`hmpg` — the feed/ETL never mapped them. This is a
> **one-time seed** from the Aurora vehicle source. **Ongoing** population is Allan's via
> etl2/DA Pulse (out of scope here).

## Plan
1. **Source (confirmed by Allan):** Aurora **`dealer_inventory`** table — **`CMPG`** (city) and
   **`HMPG`** (highway). These are legacy free-text and **contain junk**, so the seed must take
   **only clean integer values** (see guardrails). Read-only audit: coverage — how many
   `dealer_inventory` rows have a valid-integer CMPG/HMPG vs junk — and the match key.
2. **Determine the match key** to Supabase `dealer_vehicles` — VIN (uppercased) or the ETL's
   inventory key (dealer_id + stock). Report match rate + any unmatched.
3. **Dry-run the seed:** `cmpg`/`hmpg` ← Aurora, **only where the Supabase value is null** (never
   overwrite a manual entry) **and** Aurora has a value. Report count + samples. STOP for review.
4. **Seed (writes to Supabase only):** apply. Idempotent (null-guarded → re-run = 0 changes).

## Guardrails
- **Aurora is READ-ONLY — never write to it.** (Cardinal rule.)
- **Fill nulls only** — never overwrite a manually-entered `cmpg`/`hmpg`.
- **Integers only (Allan's instruction):** take a value only if it's a **clean positive
  integer** in a sane range (e.g. ~5–150 mpg). **Skip junk** — non-numeric, empty, `N/A`,
  `0`/negative, decimals/ranges, out-of-range → leave null. Validate **CMPG and HMPG
  independently** (a row may have a valid CMPG but a junk HMPG → seed the good one, null the other).
- Match by VIN (uppercased) or the ETL's key; skip no-match rather than guess.

## After
- Once seeded, the **MPG infosheet widget** + the VIN-decode same-VIN/identical-trim fill start
  working with real data.
- Ongoing freshness is Allan's via **etl2 / DA Pulse** mapping the feed MPG → `cmpg`/`hmpg` on
  every sync.

## Verify
- A vehicle with known MPG in Aurora now shows `cmpg`/`hmpg` in `dealer_vehicles` and on the MPG
  infosheet widget.
- A vehicle with a manually-entered MPG is **untouched**.
- Re-running the seed = **0 changes** (idempotent).
- Read-only audit + dry-run first; STOP for review before the write.
