-- Migration 048: Add legacy_default_id to addendum_library for ETL sync
-- Aurora addendum_defaults._ID is globally unique — used as the upsert key.
-- NULL for manually-created library options (not from Aurora).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'addendum_library' AND column_name = 'legacy_default_id'
  ) THEN
    ALTER TABLE addendum_library ADD COLUMN legacy_default_id int UNIQUE;
    COMMENT ON COLUMN addendum_library.legacy_default_id IS
      'Aurora addendum_defaults._ID — used by ETL for upsert matching. NULL for manually-created options.';
  END IF;
END$$;
