-- 129_fix_migration_status_pending_constraint.sql
--
-- Migration 112 intended to allow migration_status='pending' (the ETL-freeze
-- staging state), but its DO-block only ADDED a new constraint named
-- dealers_migration_status_chk — it never dropped the ORIGINAL constraint
-- dealers_migration_status_check (from the column's introduction), whose value
-- list lacks 'pending'. In prod the original constraint is the only one present
-- (the 112 block appears to have never landed either), so every stage attempt
-- has failed with a check violation since the feature shipped — zero dealers
-- have ever reached 'pending'.
--
-- This migration converges prod on the intended state: one canonical
-- constraint that includes 'pending'.

ALTER TABLE dealers DROP CONSTRAINT IF EXISTS dealers_migration_status_check;
ALTER TABLE dealers DROP CONSTRAINT IF EXISTS dealers_migration_status_chk;

ALTER TABLE dealers
  ADD CONSTRAINT dealers_migration_status_chk
  CHECK (migration_status IS NULL OR migration_status IN
    ('legacy','pending','invited','migrating','migrated','opted_out'))
  NOT VALID;
