-- 106_addendum_library_spaces_default_zero.sql
-- Belt-and-suspenders: flip the column DEFAULT for product-rule `spaces`
-- from 2 -> 0 on the rule stores.
--
-- Context: the ETL (da-legacy-etl src/jobs/options.ts) and the platform create
-- route (app/api/addendum-library/route.ts) used to hardcode spaces=2 on every
-- product, overriding the intended DEFAULT 0 and forcing 2 separator spaces on
-- every rendered product. Both code paths are now fixed to write 0 explicitly,
-- and a one-time data fix (scripts/fix-addendum-library-spaces.mjs, 2026-06-17)
-- zeroed the 12,448 existing rows. Every current write path sets `spaces`
-- explicitly, so NO path relies on this DEFAULT today — this migration only
-- guards against a future insert that omits the column.
--
-- The renderer derives spacing from addendum_library.spaces via
-- lib/options-engine.ts. NOTE: vehicle_options has NO `spaces` column — the rule
-- stores (addendum_library = dealer products, group_options = group products)
-- are the source.
--
-- Idempotent / no data change (DEFAULT only, not an UPDATE). Existing rows are
-- unaffected. Apply via the Supabase SQL editor (primary DA project) or
-- `supabase db push`.

ALTER TABLE public.addendum_library
  ALTER COLUMN spaces SET DEFAULT 0;

ALTER TABLE public.group_options
  ALTER COLUMN spaces SET DEFAULT 0;
