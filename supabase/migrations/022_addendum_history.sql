-- Migration 022: addendum_history
-- Historical log of every option ever applied to a vehicle.
-- Seeded from Aurora addendum_data (9.1M rows) by import-addendum-history.ts.
-- New platform events write here with source='platform'.

CREATE TABLE IF NOT EXISTS public.addendum_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id       int,                          -- Aurora _ID, for dedup
  vehicle_id      int,                          -- Aurora VEHICLE_ID
  vin             text,                         -- VIN_NUMBER (stable vehicle identifier)
  dealer_id       text,                         -- DEALER_ID (inventory_dealer_id)
  item_name       text NOT NULL,
  item_description text,
  item_price      varchar(20),
  active          varchar(3),                   -- 'Yes' | 'No'
  creation_date   date,
  separator_above smallint DEFAULT 0,
  separator_below smallint DEFAULT 0,
  separator_spaces int DEFAULT 2,
  order_by        int DEFAULT 0,
  editable        int DEFAULT 1,
  source          text DEFAULT 'aurora',        -- 'aurora' | 'platform'
  imported_at     timestamptz DEFAULT now(),
  created_at      timestamptz,
  updated_at      timestamptz
);

CREATE INDEX IF NOT EXISTS addendum_history_vin_idx        ON public.addendum_history (vin);
CREATE INDEX IF NOT EXISTS addendum_history_dealer_id_idx  ON public.addendum_history (dealer_id);
CREATE INDEX IF NOT EXISTS addendum_history_creation_date_idx ON public.addendum_history (creation_date);
CREATE INDEX IF NOT EXISTS addendum_history_legacy_id_idx  ON public.addendum_history (legacy_id);
CREATE UNIQUE INDEX IF NOT EXISTS addendum_history_legacy_id_unique ON public.addendum_history (legacy_id) WHERE legacy_id IS NOT NULL;

-- RLS
ALTER TABLE public.addendum_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "super_admin_full_addendum_history" ON public.addendum_history
  FOR ALL TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'super_admin')
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') = 'super_admin');

CREATE POLICY "dealer_read_own_addendum_history" ON public.addendum_history
  FOR SELECT TO authenticated
  USING (
    dealer_id = (auth.jwt() -> 'app_metadata' ->> 'dealer_id')
    AND (auth.jwt() -> 'app_metadata' ->> 'role') IN ('dealer_admin', 'dealer_user')
  );
