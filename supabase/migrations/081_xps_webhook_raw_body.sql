-- 081_xps_webhook_raw_body.sql
-- Persist the raw inbound body alongside the parsed payload, so when XPS
-- sends an envelope we don't anticipate (e.g. form-urlencoded instead of
-- JSON, like the 2026-05-28 Update Order webhook for label 1779998143192)
-- we can recover the data after the fact instead of having to ask the
-- shipper to re-fire the event.

ALTER TABLE public.xps_webhook_log
  ADD COLUMN IF NOT EXISTS raw_body text;
