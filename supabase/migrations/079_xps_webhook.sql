-- 079_xps_webhook.sql
-- Adds support for the inbound XPS Shipper webhook (POST /api/webhooks/xps),
-- which replaces the broken /shipments polling cron — XPS's REST list endpoint
-- only returns historical fixtures regardless of filter, so push is the only
-- reliable way to learn a tracking number.

-- Raw payload log. Every inbound webhook gets one row here regardless of
-- whether we matched it to a label_orders row, so when XPS changes field
-- names we can see what they sent.
CREATE TABLE IF NOT EXISTS public.xps_webhook_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at timestamptz NOT NULL DEFAULT now(),
  payload     jsonb       NOT NULL,
  headers     jsonb
);

CREATE INDEX IF NOT EXISTS xps_webhook_log_received_at_idx
  ON public.xps_webhook_log (received_at DESC);

-- Carrier code on the order row so the Orders tab can render the right
-- tracking-link template (USPS vs UPS vs FedEx). Optional; falls back to a
-- generic search link when null.
ALTER TABLE public.label_orders
  ADD COLUMN IF NOT EXISTS xps_carrier text;
