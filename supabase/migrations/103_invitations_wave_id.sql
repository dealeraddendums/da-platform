-- 103: tag migration invites with the wave they were sent in (Phase 13b step 3).
-- Apply in the Supabase SQL editor, then deploy. Enables per-wave summaries
-- (sent / migrated / pending) without a separate log table — per-dealer status
-- is already derivable from dealers.migration_status + invited_at + the
-- invitation row (accepted_at / expires_at).

ALTER TABLE public.invitations
  ADD COLUMN IF NOT EXISTS wave_id text NULL;  -- e.g. 'wave-2026-06-17T14:20:00Z' (migration waves only)

CREATE INDEX IF NOT EXISTS invitations_wave_idx ON public.invitations (wave_id) WHERE wave_id IS NOT NULL;
