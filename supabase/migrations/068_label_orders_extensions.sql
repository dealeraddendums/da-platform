-- Migration 068: label_orders extensions for Phase 10 tracking + routing.
--
-- billed_to / group_id captures which billing template the order was added
-- to (per labels_billed_to). xps_tracking_number is populated by the
-- /api/cron/sync-xps-tracking daily job. updated_at is the standard
-- updated-on-change column.

ALTER TABLE public.label_orders
  ADD COLUMN IF NOT EXISTS billed_to text CHECK (billed_to IN ('dealer','group')),
  ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES public.groups(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS xps_tracking_number text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS label_orders_xps_status_idx
  ON public.label_orders (xps_status);
CREATE INDEX IF NOT EXISTS label_orders_group_id_idx
  ON public.label_orders (group_id);

-- Keep updated_at fresh on writes.
CREATE OR REPLACE FUNCTION public.label_orders_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS label_orders_updated_at ON public.label_orders;
CREATE TRIGGER label_orders_updated_at
BEFORE UPDATE ON public.label_orders
FOR EACH ROW EXECUTE FUNCTION public.label_orders_touch_updated_at();
