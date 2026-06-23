CREATE TABLE migration_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id uuid NOT NULL REFERENCES dealers(id) ON DELETE CASCADE,
  event text NOT NULL, -- 'migrated', 'billing_activated', 'rollback', 'freshbooks_stopped'
  performed_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  billing_customer_id text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON migration_log (dealer_id);
CREATE INDEX ON migration_log (event);
ALTER TABLE migration_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "super_admin only" ON migration_log
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin'));
