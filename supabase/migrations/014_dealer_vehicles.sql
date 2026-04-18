-- dealer_vehicles: manual vehicle entry for Trial / Manual-subscription dealers
-- Note: numbered 014 (013 = nhtsa_vpic)

CREATE TABLE IF NOT EXISTS public.dealer_vehicles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id       text NOT NULL,
  stock_number    text NOT NULL,
  vin             text,
  year            int,
  make            text,
  model           text,
  trim            text,
  body_style      text,
  exterior_color  text,
  interior_color  text,
  engine          text,
  transmission    text,
  drivetrain      text,
  mileage         int DEFAULT 0,
  msrp            numeric(10,2),
  condition       text DEFAULT 'New',
  status          text DEFAULT 'active',
  decode_source   text,       -- 'nhtsa' | 'dealer_vehicles' | 'aurora' | 'partial' | 'manual'
  decode_flagged  bool DEFAULT false,
  date_added      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  UNIQUE(dealer_id, stock_number)
);

CREATE INDEX IF NOT EXISTS dealer_vehicles_dealer_id_idx ON public.dealer_vehicles (dealer_id);
CREATE INDEX IF NOT EXISTS dealer_vehicles_vin_idx       ON public.dealer_vehicles (vin);

ALTER TABLE public.dealer_vehicles ENABLE ROW LEVEL SECURITY;

-- Dealers see and manage their own records only
CREATE POLICY "dealer_self_select" ON public.dealer_vehicles FOR SELECT TO authenticated
  USING (
    dealer_id = (auth.jwt() -> 'app_metadata' ->> 'dealer_id')
    OR (auth.jwt() -> 'app_metadata' ->> 'role') = 'super_admin'
  );

-- Only dealer_admin/dealer_user can insert (super_admin excluded per spec)
CREATE POLICY "dealer_self_insert" ON public.dealer_vehicles FOR INSERT TO authenticated
  WITH CHECK (
    dealer_id = (auth.jwt() -> 'app_metadata' ->> 'dealer_id')
    AND (auth.jwt() -> 'app_metadata' ->> 'role') IN ('dealer_admin', 'dealer_user')
  );

CREATE POLICY "dealer_self_update" ON public.dealer_vehicles FOR UPDATE TO authenticated
  USING (
    dealer_id = (auth.jwt() -> 'app_metadata' ->> 'dealer_id')
    AND (auth.jwt() -> 'app_metadata' ->> 'role') IN ('dealer_admin', 'dealer_user')
  );

CREATE POLICY "dealer_self_delete" ON public.dealer_vehicles FOR DELETE TO authenticated
  USING (
    dealer_id = (auth.jwt() -> 'app_metadata' ->> 'dealer_id')
    AND (auth.jwt() -> 'app_metadata' ->> 'role') IN ('dealer_admin', 'dealer_user')
  );
