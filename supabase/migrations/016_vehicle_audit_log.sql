-- 016_vehicle_audit_log: per-vehicle audit trail for manual dealer vehicles

CREATE TABLE IF NOT EXISTS public.vehicle_audit_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id        text NOT NULL,
  vehicle_id       uuid REFERENCES public.dealer_vehicles(id) ON DELETE CASCADE,
  stock_number     text,
  action           text NOT NULL CHECK (action IN ('import','edit','print','delete')),
  method           text,           -- 'csv' | 'vin_decoder' | 'manual'
  changed_by       uuid REFERENCES auth.users(id),
  changed_by_email text,
  changes          jsonb,          -- {field: {old, new}} for edit events
  document_type    text,           -- 'addendum' | 'infosheet' | 'buyer_guide' for print events
  created_at       timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vehicle_audit_log_vehicle_id_idx ON public.vehicle_audit_log (vehicle_id);
CREATE INDEX IF NOT EXISTS vehicle_audit_log_dealer_id_idx  ON public.vehicle_audit_log (dealer_id);

ALTER TABLE public.vehicle_audit_log ENABLE ROW LEVEL SECURITY;

-- Dealers see their own audit log
CREATE POLICY "dealer_reads_own_audit_log"
  ON public.vehicle_audit_log FOR SELECT
  USING (
    dealer_id = (auth.jwt()->'app_metadata'->>'dealer_id')
    AND auth.jwt()->'app_metadata'->>'role' IN ('dealer_admin','dealer_user')
  );

-- super_admin and service_role full access
CREATE POLICY "super_admin_full_audit_log"
  ON public.vehicle_audit_log FOR ALL
  USING (
    auth.jwt()->'app_metadata'->>'role' = 'super_admin'
    OR auth.role() = 'service_role'
  );
