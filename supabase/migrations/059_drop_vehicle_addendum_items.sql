-- Migration 059: Drop vehicle_addendum_items.
--
-- Apply only after migration 058 has been applied AND verified — rows from
-- vehicle_addendum_items must be present in addendum_data (legacy_id IS NOT
-- NULL) at the expected count. The DA Platform code, the Legacy ETL job, the
-- backfill script, and pulse-migration-spec.md have all been updated to
-- reference addendum_data; nothing should be reading or writing this table
-- by the time this runs.

DROP TABLE IF EXISTS public.vehicle_addendum_items;
