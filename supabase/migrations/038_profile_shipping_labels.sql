-- Migration 038: dealer shipping address columns + label_orders table

-- Shipping address columns on dealers table
ALTER TABLE dealers
  ADD COLUMN IF NOT EXISTS shipping_name text,
  ADD COLUMN IF NOT EXISTS shipping_attention text,
  ADD COLUMN IF NOT EXISTS shipping_address text,
  ADD COLUMN IF NOT EXISTS shipping_address2 text,
  ADD COLUMN IF NOT EXISTS shipping_city text,
  ADD COLUMN IF NOT EXISTS shipping_state text,
  ADD COLUMN IF NOT EXISTS shipping_zip text,
  ADD COLUMN IF NOT EXISTS shipping_country text DEFAULT 'US',
  ADD COLUMN IF NOT EXISTS shipping_phone text;

-- Label orders table
CREATE TABLE IF NOT EXISTS label_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id uuid REFERENCES dealers(id),
  ordered_by uuid REFERENCES profiles(id),
  items jsonb NOT NULL,
  ship_to jsonb NOT NULL,
  total_amount numeric(10,2),
  billing_status text DEFAULT 'pending',
  email_status text DEFAULT 'pending',
  xps_status text DEFAULT 'pending',
  xps_order_id text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE label_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dealer_own_orders" ON label_orders
  FOR SELECT USING (
    dealer_id IN (
      SELECT d.id FROM dealers d
      JOIN profiles p ON p.dealer_id = d.dealer_id
      WHERE p.id = auth.uid()
    )
  );

CREATE POLICY "super_admin_all_orders" ON label_orders
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'super_admin')
  );
