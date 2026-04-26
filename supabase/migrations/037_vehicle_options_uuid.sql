-- Phase 9 Fix: Change vehicle_options.vehicle_id from bigint to text
-- This allows storing both Aurora numeric IDs and Supabase UUID strings (manual vehicles)
-- Existing rows with vehicle_id = 0 (sentinel for manual dealer vehicles) become '0'

ALTER TABLE public.vehicle_options
  ALTER COLUMN vehicle_id TYPE text USING vehicle_id::text;

-- Re-create index with correct type
DROP INDEX IF EXISTS vehicle_options_vehicle_id_idx;
CREATE INDEX vehicle_options_vehicle_id_idx ON public.vehicle_options (vehicle_id);
