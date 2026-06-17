-- 105: operator assignment for the migration tail (Phase 13b).
-- Apply in the Supabase SQL editor, then deploy.
--
-- Lets the 4-person team divide the un-migrated tail into non-overlapping
-- ~25-dealer worklists. NULL = unassigned. Points at the owning operator's auth
-- user id (profiles.id / auth.users.id). Additive — does not affect readiness.

ALTER TABLE public.dealers
  ADD COLUMN IF NOT EXISTS migration_assigned_to uuid NULL;  -- operator (super_admin) who owns this dealer's migration

CREATE INDEX IF NOT EXISTS dealers_migration_assigned_idx ON public.dealers (migration_assigned_to) WHERE migration_assigned_to IS NOT NULL;
