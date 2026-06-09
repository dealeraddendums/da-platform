-- 097_options_rule_fuel.sql
-- Add a "Fuel Type" dimension to product-assignment rules, mirroring
-- makes/makes_not exactly. Spec: docs/options-rule-fuel-type.md.
--
-- Applies to BOTH rule stores that carry the makes/makes_not columns:
--   • addendum_library (dealer products — migration 010)
--   • group_options    (corporate/group products — migration 053)
-- (vehicle_options does NOT carry rule columns — the engine reads rules from
-- addendum_library + group_options.)
--
-- fuel = CSV of selected dealer_vehicles.fuel values; '' = all fuels.
-- fuel_not = IN (false) / NOT IN (true). listMatchesWithNot already handles
-- the CSV split + IN/NOT + "empty matches all", so existing rows ('' / false)
-- behave as "All fuels" — no behavior change.
--
-- Apply via the Supabase SQL editor (primary DA project) or `supabase db push`.

ALTER TABLE public.addendum_library
  ADD COLUMN IF NOT EXISTS fuel     text    NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS fuel_not boolean NOT NULL DEFAULT false;

ALTER TABLE public.group_options
  ADD COLUMN IF NOT EXISTS fuel     text    NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS fuel_not boolean NOT NULL DEFAULT false;

-- Distinct fuel values for the rule dropdown (GET /api/vehicles/fuel-types).
-- dealer_vehicles is ~1.5M rows, so a client-side scan is infeasible — this
-- read-only STABLE function does the DISTINCT server-side. NOT an arbitrary-SQL
-- RPC: a single fixed read-only query (fuel is free-text from feeds; the API
-- case-insensitively dedupes + sorts the result for display).
CREATE OR REPLACE FUNCTION public.distinct_vehicle_fuels()
RETURNS TABLE(fuel text)
LANGUAGE sql
STABLE
AS $$
  SELECT DISTINCT btrim(dv.fuel) AS fuel
  FROM public.dealer_vehicles dv
  WHERE dv.fuel IS NOT NULL
    AND btrim(dv.fuel) <> ''
$$;
