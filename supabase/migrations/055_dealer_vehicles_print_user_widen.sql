-- dealer_vehicles.print_user was varchar(20) — wide enough for the legacy
-- Aurora numeric user_id strings (e.g. "1776785108") but not for Supabase
-- auth UUIDs (36 chars). Platform prints write claims.sub here, which
-- silently failed every time with:
--   value too long for type character varying(20)
-- and rolled back the whole atomic UPDATE, leaving print_status / print_date
-- unset. Widen to text so it accepts both legacy IDs and modern UUIDs.

ALTER TABLE dealer_vehicles
  ALTER COLUMN print_user TYPE text;
