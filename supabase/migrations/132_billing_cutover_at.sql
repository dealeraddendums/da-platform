-- 132: dealers.billing_cutover_at — stamped when a dealer's invoicing cuts over
-- to da-billing (the canonical migration writes in lib/migrate-dealer.ts, used by
-- both /api/migrate/confirm and /api/migration/migrate-group).
--
-- The column was referenced by the group-migration code (9a15ab5) and by the ETL
-- never-overwrite list, but was never actually created — every migrate call
-- failed with "Could not find the 'billing_cutover_at' column" until this.
-- NULL = migrated before this column existed (or not migrated).

ALTER TABLE dealers ADD COLUMN IF NOT EXISTS billing_cutover_at timestamptz;

COMMENT ON COLUMN dealers.billing_cutover_at IS
  'When invoicing cut over to da-billing (stamped by lib/migrate-dealer.ts on migration; NULL for pre-132 migrations)';
