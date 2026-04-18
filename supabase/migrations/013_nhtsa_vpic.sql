-- NHTSA vPIC local database tables
-- Note: numbered 013 (010-012 already used)

CREATE TABLE IF NOT EXISTS public.nhtsa_makes (
  id          int PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.nhtsa_vehicle_types (
  id          int PRIMARY KEY,
  name        text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.nhtsa_body_styles (
  id          int PRIMARY KEY,
  name        text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.nhtsa_models (
  id          int PRIMARY KEY,
  make_id     int REFERENCES nhtsa_makes(id),
  name        text NOT NULL,
  vehicle_type_id int
);

CREATE TABLE IF NOT EXISTS public.nhtsa_trims (
  id          int PRIMARY KEY,
  model_id    int REFERENCES nhtsa_models(id),
  name        text
);

CREATE TABLE IF NOT EXISTS public.nhtsa_wmi (
  wmi                 text PRIMARY KEY,
  make_id             int REFERENCES nhtsa_makes(id),
  manufacturer_name   text,
  country             text
);

CREATE TABLE IF NOT EXISTS public.nhtsa_vin_patterns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern         text NOT NULL,
  make_id         int REFERENCES nhtsa_makes(id),
  model_id        int REFERENCES nhtsa_models(id),
  trim_id         int REFERENCES nhtsa_trims(id),
  body_style_id   int REFERENCES nhtsa_body_styles(id),
  vehicle_type_id int REFERENCES nhtsa_vehicle_types(id),
  model_year      int,
  engine          text,
  displacement    text,
  cylinders       text,
  fuel_type       text,
  transmission    text,
  drivetrain      text,
  doors           int,
  created_at      timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nhtsa_vin_patterns_pattern_idx   ON public.nhtsa_vin_patterns (pattern);
CREATE INDEX IF NOT EXISTS nhtsa_vin_patterns_year_idx      ON public.nhtsa_vin_patterns (model_year);
CREATE INDEX IF NOT EXISTS nhtsa_vin_patterns_make_idx      ON public.nhtsa_vin_patterns (make_id);

CREATE TABLE IF NOT EXISTS public.nhtsa_sync_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  synced_at        timestamptz DEFAULT now(),
  records_imported int,
  source_url       text,
  status           text,  -- success / failed / in_progress
  notes            text
);

CREATE TABLE IF NOT EXISTS public.nhtsa_overrides (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vin_prefix    text NOT NULL,
  year          int,
  make          text,
  model         text,
  trim          text,
  body_style    text,
  engine        text,
  transmission  text,
  drivetrain    text,
  notes         text,
  created_by    uuid REFERENCES auth.users(id),
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nhtsa_overrides_vin_prefix_idx ON public.nhtsa_overrides (vin_prefix);

-- RLS
ALTER TABLE public.nhtsa_makes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nhtsa_vehicle_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nhtsa_body_styles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nhtsa_models        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nhtsa_trims         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nhtsa_wmi           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nhtsa_vin_patterns  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nhtsa_sync_log      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nhtsa_overrides     ENABLE ROW LEVEL SECURITY;

-- All NHTSA lookup tables: read by authenticated users
CREATE POLICY "authenticated_read" ON public.nhtsa_makes         FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read" ON public.nhtsa_vehicle_types FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read" ON public.nhtsa_body_styles   FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read" ON public.nhtsa_models        FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read" ON public.nhtsa_trims         FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read" ON public.nhtsa_wmi           FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read" ON public.nhtsa_vin_patterns  FOR SELECT TO authenticated USING (true);

-- nhtsa_sync_log: super_admin only
CREATE POLICY "super_admin_all" ON public.nhtsa_sync_log FOR ALL TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'super_admin');

-- nhtsa_overrides: read by authenticated, write by super_admin
CREATE POLICY "authenticated_read"  ON public.nhtsa_overrides FOR SELECT TO authenticated USING (true);
CREATE POLICY "super_admin_insert"  ON public.nhtsa_overrides FOR INSERT TO authenticated
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') = 'super_admin');
CREATE POLICY "super_admin_update"  ON public.nhtsa_overrides FOR UPDATE TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'super_admin');
CREATE POLICY "super_admin_delete"  ON public.nhtsa_overrides FOR DELETE TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'super_admin');
