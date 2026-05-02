-- Migration 047: Add jobs column to etl_sync_log for per-job dashboard breakdown
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'etl_sync_log' AND column_name = 'jobs'
  ) THEN
    ALTER TABLE etl_sync_log ADD COLUMN jobs jsonb NOT NULL DEFAULT '[]';
    COMMENT ON COLUMN etl_sync_log.jobs IS
      'Per-job breakdown: [{job, synced, failed, errors[], note}] for dashboard display.';
  END IF;
END$$;
