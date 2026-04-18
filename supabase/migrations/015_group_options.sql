-- 015_group_options.sql
-- Group-level locked options, state-based disclaimers, and shared templates
-- that cascade down to dealer addendums within the group.

-- ── group_options ──────────────────────────────────────────────────────────────
CREATE TABLE group_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  option_name text NOT NULL,
  option_price text NOT NULL DEFAULT 'NC',
  sort_order int NOT NULL DEFAULT 0,
  active bool NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_group_options_group_id ON group_options(group_id);

ALTER TABLE group_options ENABLE ROW LEVEL SECURITY;

-- super_admin: full access
CREATE POLICY "group_options_super_admin" ON group_options
  FOR ALL TO authenticated
  USING  ((auth.jwt()->'app_metadata'->>'role') = 'super_admin')
  WITH CHECK ((auth.jwt()->'app_metadata'->>'role') = 'super_admin');

-- group_admin: manage own group
CREATE POLICY "group_options_group_admin" ON group_options
  FOR ALL TO authenticated
  USING  (
    (auth.jwt()->'app_metadata'->>'role') = 'group_admin'
    AND group_id::text = (auth.jwt()->'app_metadata'->>'group_id')
  )
  WITH CHECK (
    (auth.jwt()->'app_metadata'->>'role') = 'group_admin'
    AND group_id::text = (auth.jwt()->'app_metadata'->>'group_id')
  );

-- dealer roles: read own group's options
CREATE POLICY "group_options_dealer_read" ON group_options
  FOR SELECT TO authenticated
  USING (
    (auth.jwt()->'app_metadata'->>'role') IN ('dealer_admin', 'dealer_user')
    AND group_id::text = (auth.jwt()->'app_metadata'->>'group_id')
  );

-- ── group_disclaimers ──────────────────────────────────────────────────────────
CREATE TABLE group_disclaimers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  state_code text NOT NULL DEFAULT 'ALL',    -- 2-char state or 'ALL'
  document_type text NOT NULL DEFAULT 'all'
    CHECK (document_type IN ('addendum', 'infosheet', 'all')),
  disclaimer_text text NOT NULL,
  active bool NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_group_disclaimers_group_id ON group_disclaimers(group_id);

ALTER TABLE group_disclaimers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "group_disclaimers_super_admin" ON group_disclaimers
  FOR ALL TO authenticated
  USING  ((auth.jwt()->'app_metadata'->>'role') = 'super_admin')
  WITH CHECK ((auth.jwt()->'app_metadata'->>'role') = 'super_admin');

CREATE POLICY "group_disclaimers_group_admin" ON group_disclaimers
  FOR ALL TO authenticated
  USING  (
    (auth.jwt()->'app_metadata'->>'role') = 'group_admin'
    AND group_id::text = (auth.jwt()->'app_metadata'->>'group_id')
  )
  WITH CHECK (
    (auth.jwt()->'app_metadata'->>'role') = 'group_admin'
    AND group_id::text = (auth.jwt()->'app_metadata'->>'group_id')
  );

CREATE POLICY "group_disclaimers_dealer_read" ON group_disclaimers
  FOR SELECT TO authenticated
  USING (
    (auth.jwt()->'app_metadata'->>'role') IN ('dealer_admin', 'dealer_user')
    AND group_id::text = (auth.jwt()->'app_metadata'->>'group_id')
  );

-- ── group_templates ────────────────────────────────────────────────────────────
CREATE TABLE group_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name text NOT NULL,
  document_type text NOT NULL CHECK (document_type IN ('addendum', 'infosheet')),
  vehicle_types text[] NOT NULL DEFAULT '{}',
  template_json jsonb NOT NULL DEFAULT '{}',
  is_locked bool NOT NULL DEFAULT false,   -- true = dealers cannot override with their own template
  is_active bool NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_group_templates_group_id ON group_templates(group_id);

ALTER TABLE group_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "group_templates_super_admin" ON group_templates
  FOR ALL TO authenticated
  USING  ((auth.jwt()->'app_metadata'->>'role') = 'super_admin')
  WITH CHECK ((auth.jwt()->'app_metadata'->>'role') = 'super_admin');

CREATE POLICY "group_templates_group_admin" ON group_templates
  FOR ALL TO authenticated
  USING  (
    (auth.jwt()->'app_metadata'->>'role') = 'group_admin'
    AND group_id::text = (auth.jwt()->'app_metadata'->>'group_id')
  )
  WITH CHECK (
    (auth.jwt()->'app_metadata'->>'role') = 'group_admin'
    AND group_id::text = (auth.jwt()->'app_metadata'->>'group_id')
  );

CREATE POLICY "group_templates_dealer_read" ON group_templates
  FOR SELECT TO authenticated
  USING (
    (auth.jwt()->'app_metadata'->>'role') IN ('dealer_admin', 'dealer_user')
    AND group_id::text = (auth.jwt()->'app_metadata'->>'group_id')
  );
