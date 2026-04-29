-- ── Migration 041: Group Admin Features ──────────────────────────────────────
-- dealer_template_assignments, dealer_option_assignments,
-- extend invitations for group users, add is_suggested to group_options

-- 1. Add is_suggested to group_options (false = corporate/locked, true = suggested)
ALTER TABLE public.group_options
  ADD COLUMN IF NOT EXISTS is_suggested boolean NOT NULL DEFAULT false;

-- 2. Extend invitations table to support group_user / group_admin invites
ALTER TABLE public.invitations
  ALTER COLUMN dealer_id DROP NOT NULL;

ALTER TABLE public.invitations
  ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES public.groups(id) ON DELETE CASCADE;

-- Expand role check to include group roles
ALTER TABLE public.invitations DROP CONSTRAINT IF EXISTS invitations_role_check;
ALTER TABLE public.invitations ADD CONSTRAINT invitations_role_check
  CHECK (role IN ('dealer_admin', 'dealer_user', 'dealer_restricted', 'group_admin', 'group_user'));

-- 3. dealer_template_assignments — group assigns a group_template to specific dealers
CREATE TABLE IF NOT EXISTS public.dealer_template_assignments (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id     uuid        REFERENCES public.dealers(id)         ON DELETE CASCADE,
  template_id   uuid        REFERENCES public.group_templates(id) ON DELETE CASCADE,
  group_id      uuid        REFERENCES public.groups(id)          ON DELETE CASCADE,
  dealer_editable boolean   NOT NULL DEFAULT false,
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  assigned_by   uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (dealer_id, template_id)
);

CREATE INDEX IF NOT EXISTS dta_dealer_idx   ON public.dealer_template_assignments (dealer_id);
CREATE INDEX IF NOT EXISTS dta_template_idx ON public.dealer_template_assignments (template_id);
CREATE INDEX IF NOT EXISTS dta_group_idx    ON public.dealer_template_assignments (group_id);

ALTER TABLE public.dealer_template_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dta_super_admin" ON public.dealer_template_assignments
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'super_admin')
  );

CREATE POLICY "dta_group_admin" ON public.dealer_template_assignments
  FOR ALL USING (
    group_id IN (
      SELECT group_id FROM public.profiles WHERE id = auth.uid() AND role = 'group_admin'
    )
  );

-- 4. dealer_option_assignments — group assigns suggested options to specific dealers
CREATE TABLE IF NOT EXISTS public.dealer_option_assignments (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id     uuid        REFERENCES public.dealers(id) ON DELETE CASCADE,
  option_id     uuid        NOT NULL,
  group_id      uuid        REFERENCES public.groups(id)  ON DELETE CASCADE,
  dealer_editable boolean   NOT NULL DEFAULT true,
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  assigned_by   uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (dealer_id, option_id)
);

CREATE INDEX IF NOT EXISTS doa_dealer_idx ON public.dealer_option_assignments (dealer_id);
CREATE INDEX IF NOT EXISTS doa_option_idx ON public.dealer_option_assignments (option_id);
CREATE INDEX IF NOT EXISTS doa_group_idx  ON public.dealer_option_assignments (group_id);

ALTER TABLE public.dealer_option_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "doa_super_admin" ON public.dealer_option_assignments
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'super_admin')
  );

CREATE POLICY "doa_group_admin" ON public.dealer_option_assignments
  FOR ALL USING (
    group_id IN (
      SELECT group_id FROM public.profiles WHERE id = auth.uid() AND role = 'group_admin'
    )
  );
