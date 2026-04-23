-- Migration 030: Change print_history.vehicle_id from bigint to text
-- dealer_vehicles.id is UUID; this column must support both legacy integer IDs
-- (stored as their string representations) and Supabase UUID strings.
ALTER TABLE public.print_history
  ALTER COLUMN vehicle_id TYPE text USING vehicle_id::text;
