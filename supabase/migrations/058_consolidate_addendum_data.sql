-- Migration 058: Consolidate vehicle_addendum_items → addendum_data.
--
-- We have two tables holding addendum line items:
--   - addendum_data           (~3.6M rows, platform writes, legacy_id NULL)
--   - vehicle_addendum_items  (~292k rows, May 2026 Aurora backfill, aurora_id set)
--
-- This migration migrates every row from vehicle_addendum_items into
-- addendum_data (mapping aurora_id → legacy_id, vin → vin_number, etc).
-- The Aurora ETL upsert uses ON CONFLICT (legacy_id), which Postgres
-- infers against the partial unique index created in migration 046
-- (addendum_data_legacy_id_idx). No new constraint is required.
--
-- Step 6 of the consolidation (DROP TABLE vehicle_addendum_items) is deferred
-- to migration 059 so the data move can be verified first.
--
-- Idempotent — the INSERT … SELECT skips rows whose legacy_id is already
-- present (existing partial unique index on legacy_id would also reject
-- them; the NOT EXISTS pre-filter keeps the load lighter).

-- ── Migrate vehicle_addendum_items → addendum_data ────────────────────────────
-- legacy_dealer_id is sourced from dealers.dealer_id (NOT dealers.internal_id —
-- verified 2026-05-11 against Aurora: Aurora DEALER_ID matches dealers.dealer_id,
-- e.g. 'MP14056', while dealers.internal_id is a separate platform-side ID).
-- document_type is forced to 'addendum' because Aurora addendum_data only
-- carries addendum line items (Aurora has no infosheet / buyers_guide split).

INSERT INTO public.addendum_data (
  dealer_id,
  legacy_dealer_id,
  vehicle_id,
  vin_number,
  item_name,
  item_price,
  legacy_id,
  document_type,
  created_at,
  updated_at
)
SELECT
  vai.dealer_id,
  d.dealer_id,
  vai.vehicle_id,
  vai.vin,
  vai.item_name,
  vai.item_price::text,
  vai.aurora_id::integer,
  'addendum',
  COALESCE(vai.created_at_aurora, vai.synced_at, now()),
  COALESCE(vai.updated_at_aurora, vai.synced_at, now())
FROM public.vehicle_addendum_items vai
JOIN public.dealers d ON d.id = vai.dealer_id
WHERE vai.aurora_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.addendum_data ad
    WHERE ad.dealer_id = vai.dealer_id
      AND ad.legacy_id = vai.aurora_id::integer
  );

-- Verification helper:
--   SELECT COUNT(*) FROM public.addendum_data WHERE legacy_id IS NOT NULL;
-- Expected: ≈ row count of vehicle_addendum_items at migration time (~292k).
