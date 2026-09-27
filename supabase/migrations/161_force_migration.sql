-- 161 — Force-migration flow (drip → Force Migration queue → manual force).
-- Spec: suite root force-migration-spec.md.
--
-- Why a NEW drip counter instead of reusing invite_follow_up_count:
-- the old drip was 3/10/30/60/90 and most of the invited backlog already sits
-- at counts 1–5 on that track. Reusing the column would either (a) exclude the
-- longest-stalled dealers — exactly the ones we need to force — because their
-- count is already >= the new max, or (b) require a mass reset that silently
-- re-triggers email. A separate stage counter starts every invited dealer at 0
-- on the new 14/21/23 track, so nobody is forced without receiving the new
-- mandatory final notice, and the legacy counter stays intact for history.

ALTER TABLE dealers
  -- 0 = no new-track follow-up sent yet; 1 = day 14, 2 = day 21, 3 = day 23 final notice
  ADD COLUMN IF NOT EXISTS force_drip_stage   integer     NOT NULL DEFAULT 0,
  -- Set when the day-23 MANDATORY FINAL NOTICE actually sends. This — not the
  -- stage counter — is the gate for appearing in the Force Migration queue:
  -- a dealer is never forceable unless we can prove the final notice went out.
  ADD COLUMN IF NOT EXISTS final_notice_at    timestamptz,
  -- Operator "park this dealer" toggle. Held dealers are EXCLUDED from forcing.
  ADD COLUMN IF NOT EXISTS force_hold         boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS force_hold_reason  text,
  -- Audit stamps for the force itself (migration_log carries the full row).
  ADD COLUMN IF NOT EXISTS forced_at          timestamptz,
  ADD COLUMN IF NOT EXISTS forced_by          uuid;

COMMENT ON COLUMN dealers.force_drip_stage  IS 'Force-migration drip stage on the 14/21/23-day track (0-3). Separate from the legacy invite_follow_up_count.';
COMMENT ON COLUMN dealers.final_notice_at   IS 'When the day-23 mandatory final notice sent. Required before a dealer can appear as SAFE TO FORCE.';
COMMENT ON COLUMN dealers.force_hold        IS 'Operator hold — dealer is parked and excluded from the Force Migration queue.';
COMMENT ON COLUMN dealers.forced_at         IS 'When a team member force-migrated this dealer (null after un-force).';
COMMENT ON COLUMN dealers.forced_by         IS 'auth.users id of the operator who forced the migration.';

-- The queue reads invited + final-notice-sent + not-held.
CREATE INDEX IF NOT EXISTS idx_dealers_force_queue
  ON dealers (migration_status, final_notice_at)
  WHERE migration_status = 'invited';

-- The drip cron reads invited + active + stage < 3.
CREATE INDEX IF NOT EXISTS idx_dealers_force_drip
  ON dealers (migration_status, force_drip_stage)
  WHERE migration_status = 'invited';
