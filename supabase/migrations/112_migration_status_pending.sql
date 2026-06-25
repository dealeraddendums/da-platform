-- 112_migration_status_pending.sql
--
-- Change 1A: introduce migration_status = 'pending' as a recognized value.
--
-- dealers.migration_status is a plain TEXT column (added in migration 045 —
-- `ALTER TABLE dealers ADD COLUMN migration_status text`), NOT a Postgres enum.
-- A text column already accepts any string, so no type change is required to
-- start using 'pending'. This migration is documentation + a guard rail.
--
-- Semantics of the values now in use:
--   NULL / 'legacy'  → never migrated; the DA Legacy ETL keeps syncing it.
--   'pending'        → staged for an upcoming migration wave. The ETL FREEZES
--                      this dealer immediately (runner.ts excludes both
--                      'migrated' and 'pending') so it stops overwriting the
--                      dealer's settings BEFORE migration completes.
--   'migrated'       → fully migrated; ETL skips it permanently.
--
-- A dealer is set to 'pending' by POST /api/migration/stage-dealer (super_admin),
-- which also writes a migration_log row (event = 'staged_for_migration').
--
-- Optional integrity guard: keep migration_status within the known set. Kept as
-- a NOT VALID check so it never fails on pre-existing rows and is cheap to add.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dealers_migration_status_chk'
  ) THEN
    ALTER TABLE dealers
      ADD CONSTRAINT dealers_migration_status_chk
      CHECK (migration_status IS NULL OR migration_status IN
        ('legacy','pending','invited','migrating','migrated','opted_out'))
      NOT VALID;
  END IF;
END $$;

-- Index on migration_status already exists (idx_dealers_migration_status, mig 045).
