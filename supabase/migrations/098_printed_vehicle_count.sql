-- 098_printed_vehicle_count.sql
-- Count DISTINCT printed vehicles, not print_history rows. A row is logged per
-- vehicle per PDF generation (every preview-modal open), so row counts inflate
-- on reprints — a trial dealer who reprinted the same 15-vehicle batch logged
-- ~36 rows and was wrongly blocked by the 30-print trial cap.
-- Spec: docs/multiprint-qa-2026-06-11.md (Issue B).
--
-- NOT an arbitrary-SQL RPC: a single fixed read-only aggregate, mirroring the
-- distinct_vehicle_fuels() convention from migration 097.
--
-- All three params optional so one function serves every counter:
--   p_dealer_id            → one dealer (trial cap, billing trial progress,
--                            HubSpot lifetime / 12-mo counts)
--   p_dealer_ids           → a set of dealers (group-admin "addendums this month")
--   p_since                → time window (NULL = lifetime)
--   all NULL               → platform-wide (super_admin "addendums this month")
CREATE OR REPLACE FUNCTION public.printed_vehicle_count(
  p_dealer_id  text        DEFAULT NULL,
  p_dealer_ids text[]      DEFAULT NULL,
  p_since      timestamptz DEFAULT NULL
) RETURNS integer
LANGUAGE sql
STABLE
AS $$
  SELECT count(DISTINCT vehicle_id)::int
  FROM public.print_history
  WHERE (p_dealer_id  IS NULL OR dealer_id = p_dealer_id)
    AND (p_dealer_ids IS NULL OR dealer_id = ANY(p_dealer_ids))
    AND (p_since      IS NULL OR created_at >= p_since);
$$;

-- Service-role only — nothing client-side calls this, and print counts are
-- cross-dealer data the anon/authenticated PostgREST surface shouldn't expose.
REVOKE EXECUTE ON FUNCTION public.printed_vehicle_count(text, text[], timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.printed_vehicle_count(text, text[], timestamptz) TO service_role;
