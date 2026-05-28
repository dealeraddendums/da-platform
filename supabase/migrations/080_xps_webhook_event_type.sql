-- 080_xps_webhook_event_type.sql
-- Distinguishes shipment-update push events from list-orders polls in
-- xps_webhook_log. XPS requires us to advertise a "list orders" URL even
-- though we PUT orders directly when placed, so the GET poll lands here
-- too. Without an event_type column the two stream into one undifferentiated
-- log.

ALTER TABLE public.xps_webhook_log
  ADD COLUMN IF NOT EXISTS event_type text;

CREATE INDEX IF NOT EXISTS xps_webhook_log_event_type_idx
  ON public.xps_webhook_log (event_type, received_at DESC);
