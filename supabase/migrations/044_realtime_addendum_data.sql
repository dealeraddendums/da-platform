-- Migration 044: Enable Supabase Realtime on addendum_data
-- Required for the dashboard live activity feed.
--
-- If this fails (permission denied), enable Realtime manually:
--   Supabase Dashboard → Database → Replication → supabase_realtime → Tables
--   Toggle ON for: addendum_data

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.addendum_data;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not add addendum_data to supabase_realtime. Enable Realtime manually in the Supabase Dashboard under Database → Replication.';
END $$;
