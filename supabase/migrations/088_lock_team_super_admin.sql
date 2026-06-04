-- Migration 088: Lock DA team accounts to super_admin
--
-- Problem: the daily DA Legacy ETL (Job 3 — Profiles) upserts profiles matched
-- on email and maps Aurora's USER_TYPE -> role. The DA team's own accounts exist
-- in Aurora tagged as a dealer-level user type, so every nightly ETL run was
-- silently downgrading them from 'super_admin' back to 'dealer_admin'. The same
-- would happen if scripts/import-users.ts were re-run.
--
-- Fix (writer-agnostic): a BEFORE INSERT OR UPDATE trigger on public.profiles
-- that pins the protected team emails to role='super_admin' and active=true.
-- This holds regardless of which process writes the row (ETL in a separate repo,
-- import script, or any API upsert), so the lock can't be circumvented by a
-- caller that forgets to set the role.
--
-- To add or remove a protected team member, edit the email array in
-- public.enforce_team_super_admin() via a new migration.

-- ── Protected-team guard function ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_team_super_admin()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF lower(NEW.email) = ANY (ARRAY[
    'allan@dealeraddendums.com',
    'alex@dealeraddendums.com',
    'claire@dealeraddendums.com',
    'marlena@dealeraddendums.com',
    'carol@dealeraddendums.com'
  ]) THEN
    NEW.role   := 'super_admin';
    NEW.active := true;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_enforce_team_super_admin ON public.profiles;

-- Fires before the existing profiles_updated_at trigger by name ordering
-- ("enforce" < "updated_at"), but order is irrelevant here — they touch
-- different columns.
CREATE TRIGGER profiles_enforce_team_super_admin
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_team_super_admin();

-- ── One-time backfill: restore any team account already downgraded ───────────
UPDATE public.profiles
SET role = 'super_admin', active = true
WHERE lower(email) IN (
  'allan@dealeraddendums.com',
  'alex@dealeraddendums.com',
  'claire@dealeraddendums.com',
  'marlena@dealeraddendums.com',
  'carol@dealeraddendums.com'
)
AND (role <> 'super_admin' OR active <> true);
