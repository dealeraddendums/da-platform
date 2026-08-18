-- 146 — Group self-service migration + 4.0 lockout tracking (2026-08-18).
--
-- (1) groups.self_manages_migration: super_admin-set trust toggle letting a
--     migrated, GROUP-BILLED service-provider group (driver: Dealer General)
--     migrate its own member dealers from My Group -> Dealers. The self-service
--     endpoints require this flag AND the group's da-billing customer.
--
-- (2) dealers.legacy_lockout_at / legacy_lockout_pending: tracking for the
--     automatic 4.0 `migrated_to_v5` lockout call fired by the shared migrate
--     helper. `at` = 4.0 confirmed the flag; `pending` = the call failed or the
--     4.0 endpoint isn't built yet (operator flips the 4.0 admin toggle
--     manually, like freshbooksStopPending). Historical migrated dealers stay
--     pending=false (no retroactive noise).
--
-- Apply via Supabase SQL editor (Dashboard -> SQL editor -> Run).

ALTER TABLE groups
  ADD COLUMN IF NOT EXISTS self_manages_migration boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN groups.self_manages_migration IS
  'Trust toggle (super_admin): this migrated, group-billed group may migrate its own member dealers via My Group (POST /api/groups/[id]/self-migrate).';

ALTER TABLE dealers
  ADD COLUMN IF NOT EXISTS legacy_lockout_at timestamptz,
  ADD COLUMN IF NOT EXISTS legacy_lockout_pending boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN dealers.legacy_lockout_at IS
  '4.0 confirmed migrated_to_v5=Yes for this dealer (set by the shared migrate helper via the 4.0-owned lockout endpoint — 5.0 never writes Aurora).';
COMMENT ON COLUMN dealers.legacy_lockout_pending IS
  'The automatic 4.0 lockout call failed or the 4.0 endpoint is not available — operator sets the 4.0 admin toggle manually, then this clears on retry/manual mark.';
