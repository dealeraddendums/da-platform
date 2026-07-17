-- 130_dealer_sync_tracking.sql
--
-- Manual "Sync" action (Migration Console) replaces the nightly ETL config
-- overwrite (decision 2026-07-16). Track when a dealer was last pulled from
-- Aurora and by whom, so the console can show "Synced {date}" and operators
-- can tell a fresh pull from a stale one.

ALTER TABLE dealers ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;
ALTER TABLE dealers ADD COLUMN IF NOT EXISTS last_synced_by uuid;

COMMENT ON COLUMN dealers.last_synced_at IS 'Last manual Aurora sync (Migration Console Sync action, 2026-07-17). NULL = never manually synced.';
COMMENT ON COLUMN dealers.last_synced_by IS 'profiles.id of the operator who ran the last manual sync.';
