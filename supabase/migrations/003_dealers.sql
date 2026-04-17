-- Phase 2: dealers table + RLS

CREATE TABLE IF NOT EXISTS public.dealers (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id             text        UNIQUE NOT NULL,
  name                  text        NOT NULL,
  active                boolean     NOT NULL DEFAULT true,
  group_id              uuid        NULL,
  primary_contact       text,
  primary_contact_email text,
  phone                 text,
  logo_url              text,
  address               text,
  city                  text,
  state                 text,
  zip                   text,
  country               text        NOT NULL DEFAULT 'US',
  makes                 text[]      NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dealers_dealer_id_idx ON public.dealers (dealer_id);
CREATE INDEX IF NOT EXISTS dealers_active_idx    ON public.dealers (active);
CREATE INDEX IF NOT EXISTS dealers_group_id_idx  ON public.dealers (group_id) WHERE group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS dealers_name_idx      ON public.dealers (name);

ALTER TABLE public.dealers ENABLE ROW LEVEL SECURITY;

-- super_admin: full access (also bypassed by service_role key in API routes)
CREATE POLICY "dealers_super_admin_all" ON public.dealers
  FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin')
  );

-- dealer_admin + dealer_user: read own dealer record
CREATE POLICY "dealers_self_read" ON public.dealers
  FOR SELECT
  USING (
    dealer_id = (
      SELECT p.dealer_id FROM public.profiles p WHERE p.id = auth.uid() LIMIT 1
    )
  );

-- dealer_admin: update own dealer record
CREATE POLICY "dealers_admin_update" ON public.dealers
  FOR UPDATE
  USING (
    dealer_id = (
      SELECT p.dealer_id FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'dealer_admin' LIMIT 1
    )
  )
  WITH CHECK (
    dealer_id = (
      SELECT p.dealer_id FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'dealer_admin' LIMIT 1
    )
  );

-- Reuse the set_updated_at function created in 001_profiles.sql
CREATE OR REPLACE TRIGGER dealers_updated_at
  BEFORE UPDATE ON public.dealers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
