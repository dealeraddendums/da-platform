-- dealer_custom_sizes: per-dealer custom paper sizes for addendums
CREATE TABLE IF NOT EXISTS dealer_custom_sizes (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id   TEXT         NOT NULL,
  name        TEXT         NOT NULL,
  width_in    NUMERIC(6,4) NOT NULL,
  height_in   NUMERIC(6,4) NOT NULL DEFAULT 11,
  background_url TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- buyers_guide_defaults: JSONB settings blob for the Buyer's Guide form
ALTER TABLE dealer_settings
  ADD COLUMN IF NOT EXISTS buyers_guide_defaults JSONB;

-- RLS
ALTER TABLE dealer_custom_sizes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "super_admin_custom_sizes_all"
  ON dealer_custom_sizes FOR ALL
  USING ((auth.jwt() ->> 'role') = 'super_admin');

CREATE POLICY "group_admin_custom_sizes_read"
  ON dealer_custom_sizes FOR SELECT
  USING ((auth.jwt() ->> 'role') = 'group_admin');

CREATE POLICY "dealer_own_custom_sizes"
  ON dealer_custom_sizes FOR ALL
  USING (dealer_id = (auth.jwt() ->> 'dealer_id'));
