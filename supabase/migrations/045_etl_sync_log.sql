-- Migration 045: ETL sync log + migration_status on dealers
-- Supports the DA Legacy ETL service (da-legacy-etl repo)

-- ── etl_sync_log ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS etl_sync_log (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at               timestamptz NOT NULL DEFAULT now(),
  dealers_processed    int         NOT NULL DEFAULT 0,
  records_synced       int         NOT NULL DEFAULT 0,
  records_failed       int         NOT NULL DEFAULT 0,
  errors               jsonb       NOT NULL DEFAULT '[]',
  duration_ms          int         NOT NULL DEFAULT 0,
  consecutive_failures jsonb       NOT NULL DEFAULT '{}',
  created_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE etl_sync_log ENABLE ROW LEVEL SECURITY;

-- Service role only — no user-facing RLS policies
CREATE POLICY "service role only" ON etl_sync_log
  USING (false);

-- ── migration_status on dealers ───────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'dealers' AND column_name = 'migration_status'
  ) THEN
    ALTER TABLE dealers ADD COLUMN migration_status text
      DEFAULT 'legacy'
      CHECK (migration_status IN ('legacy','invited','migrating','migrated','opted_out'));

    COMMENT ON COLUMN dealers.migration_status IS
      'Tracks migration from legacy PHP platform. legacy=still on old platform, migrated=fully on new platform.';
  END IF;
END$$;

-- ── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_etl_sync_log_run_at ON etl_sync_log (run_at DESC);
CREATE INDEX IF NOT EXISTS idx_dealers_migration_status ON dealers (migration_status);

-- ── legacy_default_id on vehicle_options (for ETL upsert) ──────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'vehicle_options' AND column_name = 'legacy_default_id'
  ) THEN
    ALTER TABLE vehicle_options ADD COLUMN legacy_default_id int UNIQUE;
    COMMENT ON COLUMN vehicle_options.legacy_default_id IS
      'Aurora addendum_defaults._ID — used by ETL for upsert matching.';
  END IF;
END$$;

-- ── legacy_user_id on profiles (for ETL profile sync) ─────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'profiles' AND column_name = 'legacy_user_id'
  ) THEN
    ALTER TABLE profiles ADD COLUMN legacy_user_id int UNIQUE;
  END IF;
END$$;

-- ── legacy_id on print_history (for ETL matching) ─────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'print_history' AND column_name = 'legacy_dealer_id'
  ) THEN
    ALTER TABLE print_history ADD COLUMN legacy_dealer_id text;
    ALTER TABLE print_history ADD COLUMN legacy_vehicle_id int;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'print_history' AND column_name = 'legacy_history_id'
  ) THEN
    ALTER TABLE print_history ADD COLUMN legacy_history_id bigint UNIQUE;
    COMMENT ON COLUMN print_history.legacy_history_id IS
      'Aurora vehicle_histories.id (action_id=7) — used by ETL for incremental upsert.';
    CREATE INDEX IF NOT EXISTS idx_print_history_legacy_history_id ON print_history (legacy_history_id);
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'print_history' AND column_name = 'legacy_user_id'
  ) THEN
    ALTER TABLE print_history ADD COLUMN legacy_user_id int;
  END IF;
END$$;
