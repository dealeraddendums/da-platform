-- 104: track the operator-queued FreshBooks recurring-stop (Phase 13d).
-- Apply in the Supabase SQL editor, then deploy.
--
-- True FreshBooks auto-termination isn't built (FreshBooks lives in the legacy
-- platform; its OAuth refresh token rotates on every use — dry-run-then-live
-- burns it). So the stop stays a careful MANUAL operator action (13a.3 already
-- alerts the team per migration). This column lets the console track which
-- migrated dealers still need their FreshBooks recurring stopped, so none slip.

ALTER TABLE public.dealers
  ADD COLUMN IF NOT EXISTS freshbooks_stopped_at timestamptz NULL;  -- operator marks when they've stopped the legacy FreshBooks recurring
