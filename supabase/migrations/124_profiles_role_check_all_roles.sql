-- Migration 124: widen profiles_role_check to all six platform roles.
--
-- Migration 001 created profiles.role with CHECK (role IN ('super_admin',
-- 'group_admin', 'dealer_admin', 'dealer_user')) and no later migration
-- widened it — so 'group_user' (Regional Manager, migration 109 / commit
-- 300529b) and 'dealer_restricted' can't actually be written to profiles.
-- Surfaced 2026-07-07 by the QA dealer_restricted role flip (DA Mobile M2);
-- also blocks creating the first real Regional Manager.
--
-- Applied via the Supabase SQL editor by Allan — never from the prod box.

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('super_admin', 'group_admin', 'group_user',
                  'dealer_admin', 'dealer_user', 'dealer_restricted'));
