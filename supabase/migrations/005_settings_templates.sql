-- Phase 5: templates + dealer_settings tables with RLS

-- ── templates ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.templates (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id     text        NOT NULL REFERENCES public.dealers(dealer_id) ON DELETE CASCADE,
  name          text        NOT NULL,
  document_type text        NOT NULL CHECK (document_type IN ('addendum','infosheet')),
  vehicle_types text[]      NOT NULL DEFAULT '{}',
  template_json jsonb       NOT NULL DEFAULT '{}',
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS templates_dealer_id_idx     ON public.templates (dealer_id);
CREATE INDEX IF NOT EXISTS templates_document_type_idx ON public.templates (document_type);

ALTER TABLE public.templates ENABLE ROW LEVEL SECURITY;

-- super_admin: full access
CREATE POLICY "templates_super_admin_all" ON public.templates
  FOR ALL
  USING   (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin'));

-- dealer_admin + dealer_user: read own dealer's templates
CREATE POLICY "templates_dealer_read" ON public.templates
  FOR SELECT
  USING (
    dealer_id = (SELECT p.dealer_id FROM public.profiles p WHERE p.id = auth.uid() LIMIT 1)
  );

-- dealer_admin: create/update/delete own dealer's templates
CREATE POLICY "templates_dealer_admin_write" ON public.templates
  FOR ALL
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

-- group_admin: read templates for dealers in their group
CREATE POLICY "templates_group_admin_read" ON public.templates
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.dealers d
      JOIN public.profiles p ON p.group_id = d.group_id
      WHERE d.dealer_id = templates.dealer_id
        AND p.id = auth.uid()
        AND p.role = 'group_admin'
    )
  );

CREATE OR REPLACE TRIGGER templates_updated_at
  BEFORE UPDATE ON public.templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── dealer_settings ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.dealer_settings (
  dealer_id             text        PRIMARY KEY REFERENCES public.dealers(dealer_id) ON DELETE CASCADE,
  ai_content_default    boolean     NOT NULL DEFAULT false,
  nudge_left            integer     NOT NULL DEFAULT 0,
  nudge_right           integer     NOT NULL DEFAULT 0,
  nudge_top             integer     NOT NULL DEFAULT 0,
  nudge_bottom          integer     NOT NULL DEFAULT 0,
  default_template_new  uuid        NULL REFERENCES public.templates(id) ON DELETE SET NULL,
  default_template_used uuid        NULL REFERENCES public.templates(id) ON DELETE SET NULL,
  default_template_cpo  uuid        NULL REFERENCES public.templates(id) ON DELETE SET NULL,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.dealer_settings ENABLE ROW LEVEL SECURITY;

-- super_admin: full access
CREATE POLICY "dealer_settings_super_admin_all" ON public.dealer_settings
  FOR ALL
  USING   (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin'));

-- dealer_admin + dealer_user: read own settings
CREATE POLICY "dealer_settings_self_read" ON public.dealer_settings
  FOR SELECT
  USING (
    dealer_id = (SELECT p.dealer_id FROM public.profiles p WHERE p.id = auth.uid() LIMIT 1)
  );

-- dealer_admin: upsert own settings
CREATE POLICY "dealer_settings_admin_insert" ON public.dealer_settings
  FOR INSERT
  WITH CHECK (
    dealer_id = (
      SELECT p.dealer_id FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'dealer_admin' LIMIT 1
    )
  );

CREATE POLICY "dealer_settings_admin_update" ON public.dealer_settings
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

-- group_admin: read settings for dealers in their group
CREATE POLICY "dealer_settings_group_admin_read" ON public.dealer_settings
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.dealers d
      JOIN public.profiles p ON p.group_id = d.group_id
      WHERE d.dealer_id = dealer_settings.dealer_id
        AND p.id = auth.uid()
        AND p.role = 'group_admin'
    )
  );

CREATE OR REPLACE TRIGGER dealer_settings_updated_at
  BEFORE UPDATE ON public.dealer_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
