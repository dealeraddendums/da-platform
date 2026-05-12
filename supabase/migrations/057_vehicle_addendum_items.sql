-- One-time backfill target for historical addendum line items pulled from
-- Aurora dealeraddendums.addendum_data. Each row is one product line item
-- on one sold vehicle's printed addendum. The existing public.addendum_data
-- table is reserved for the ongoing ETL / new-print flow (it carries
-- s3_key, document_type, printed_at, etc.) — this table is purely a
-- historical record without those runtime columns.
--
-- (dealer_id, aurora_id) is the dedup key so the backfill script can be
-- re-run safely with ON CONFLICT DO NOTHING.

CREATE TABLE IF NOT EXISTS public.vehicle_addendum_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id           uuid NOT NULL REFERENCES public.dealers(id) ON DELETE CASCADE,
  vehicle_id          uuid NOT NULL REFERENCES public.dealer_vehicles(id) ON DELETE CASCADE,
  aurora_id           bigint,                        -- original _ID from addendum_data
  vin                 text NOT NULL,
  item_name           text,
  item_price          numeric(10, 2),
  creation_date       date,
  created_at_aurora   timestamptz,
  updated_at_aurora   timestamptz,
  synced_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dealer_id, aurora_id)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_addendum_items_vehicle_id
  ON public.vehicle_addendum_items (vehicle_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_addendum_items_dealer_id
  ON public.vehicle_addendum_items (dealer_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_addendum_items_vin
  ON public.vehicle_addendum_items (vin);
