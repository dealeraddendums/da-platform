-- Migration 046: Add legacy_id to addendum_data for ETL incremental sync
-- Aurora addendum_data._ID used as the dedup key for the ETL service.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'addendum_data' AND column_name = 'legacy_id'
  ) THEN
    ALTER TABLE addendum_data ADD COLUMN legacy_id int;
    CREATE UNIQUE INDEX IF NOT EXISTS addendum_data_legacy_id_idx ON addendum_data (legacy_id)
      WHERE legacy_id IS NOT NULL;
    COMMENT ON COLUMN addendum_data.legacy_id IS
      'Aurora addendum_data._ID — used by ETL for incremental upsert matching.';
  END IF;
END$$;
