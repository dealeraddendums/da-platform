-- 083_dealers_downgraded_inactivated.sql
-- Phase 14 follow-up — Downgraded lifecycle + 60-day archive cron.
--
-- downgraded_at  set the moment a paying account is moved to Free; cleared
--                on re-upgrade. Drives the "Downgraded" (108387744) HubSpot
--                lifecyclestage and the 60-day archive cron.
-- inactivated_at set when the archive cron flips `active=false`. The
--                existing `active` boolean stays the operational gate;
--                the timestamp gives us "when did this happen" for audit
--                + future reactivation windows. dealers had no equivalent
--                column today (confirmed via column scan 2026-05-31).

ALTER TABLE public.dealers
  ADD COLUMN IF NOT EXISTS downgraded_at  timestamptz NULL,
  ADD COLUMN IF NOT EXISTS inactivated_at timestamptz NULL;

-- Cron-side filter is `downgraded_at < now() - 60 days AND active = true` —
-- partial index keeps that scan cheap once the field is in heavy use.
CREATE INDEX IF NOT EXISTS dealers_downgraded_at_idx
  ON public.dealers (downgraded_at)
  WHERE downgraded_at IS NOT NULL AND active = true;
