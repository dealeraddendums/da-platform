-- Migration 027: Profiles extensions + user_permissions table

-- ── Add new columns to profiles ─────────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS legacy_user_id   int,
  ADD COLUMN IF NOT EXISTS phone            text,
  ADD COLUMN IF NOT EXISTS user_image       text,
  ADD COLUMN IF NOT EXISTS hubspot_contact_id text,
  ADD COLUMN IF NOT EXISTS force_password_reset boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_login       timestamptz,
  ADD COLUMN IF NOT EXISTS last_activity    timestamptz,
  ADD COLUMN IF NOT EXISTS email_report     int,
  ADD COLUMN IF NOT EXISTS report_send_to   text,
  ADD COLUMN IF NOT EXISTS active           boolean NOT NULL DEFAULT true;

-- Partial unique index: multiple NULLs allowed
CREATE UNIQUE INDEX IF NOT EXISTS profiles_legacy_user_id_unique
  ON public.profiles (legacy_user_id)
  WHERE legacy_user_id IS NOT NULL;

-- ── user_permissions table ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_permissions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role                      text NOT NULL UNIQUE,
  -- Inventory
  can_view_inventory        boolean NOT NULL DEFAULT true,
  can_add_vehicles          boolean NOT NULL DEFAULT true,
  can_edit_vehicles         boolean NOT NULL DEFAULT true,
  can_delete_vehicles       boolean NOT NULL DEFAULT true,
  -- Documents
  can_print_addendums       boolean NOT NULL DEFAULT true,
  can_print_infosheets      boolean NOT NULL DEFAULT true,
  can_use_builder           boolean NOT NULL DEFAULT true,
  -- Options / Library
  can_view_options_library  boolean NOT NULL DEFAULT true,
  can_edit_options_library  boolean NOT NULL DEFAULT true,
  -- Templates
  can_view_templates        boolean NOT NULL DEFAULT true,
  can_edit_templates        boolean NOT NULL DEFAULT true,
  -- Reports & Data
  can_view_reports          boolean NOT NULL DEFAULT true,
  can_export_data           boolean NOT NULL DEFAULT true,
  -- Settings
  can_view_settings         boolean NOT NULL DEFAULT true,
  can_edit_settings         boolean NOT NULL DEFAULT true,
  -- Users
  can_manage_users          boolean NOT NULL DEFAULT false,
  -- Dealers & Groups (admin-level)
  can_view_dealers          boolean NOT NULL DEFAULT false,
  can_edit_dealers          boolean NOT NULL DEFAULT false,
  can_view_groups           boolean NOT NULL DEFAULT false,
  can_edit_groups           boolean NOT NULL DEFAULT false,
  can_impersonate_dealers   boolean NOT NULL DEFAULT false,
  -- Billing
  can_view_billing          boolean NOT NULL DEFAULT true,
  -- AI & API
  can_use_ai_content        boolean NOT NULL DEFAULT true,
  can_manage_api_keys       boolean NOT NULL DEFAULT false,

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_permissions ENABLE ROW LEVEL SECURITY;

-- super_admin: full access
CREATE POLICY "super_admin_full_permissions"
  ON public.user_permissions
  FOR ALL
  TO authenticated
  USING ( (auth.jwt() ->> 'role') = 'super_admin' )
  WITH CHECK ( (auth.jwt() ->> 'role') = 'super_admin' );

-- all authenticated: can read own role's permissions
CREATE POLICY "read_own_role_permissions"
  ON public.user_permissions
  FOR SELECT
  TO authenticated
  USING ( role = (auth.jwt() ->> 'role') );

-- ── Seed default permissions per role ────────────────────────────────────────
INSERT INTO public.user_permissions (role,
  can_view_inventory, can_add_vehicles, can_edit_vehicles, can_delete_vehicles,
  can_print_addendums, can_print_infosheets, can_use_builder,
  can_view_options_library, can_edit_options_library,
  can_view_templates, can_edit_templates,
  can_view_reports, can_export_data,
  can_view_settings, can_edit_settings,
  can_manage_users,
  can_view_dealers, can_edit_dealers, can_view_groups, can_edit_groups,
  can_impersonate_dealers,
  can_view_billing, can_use_ai_content, can_manage_api_keys
) VALUES
-- super_admin: everything
('super_admin',
  true, true, true, true,
  true, true, true,
  true, true,
  true, true,
  true, true,
  true, true,
  true,
  true, true, true, true,
  true,
  true, true, true),

-- group_admin: full except impersonate and api keys
('group_admin',
  true, true, true, true,
  true, true, true,
  true, true,
  true, true,
  true, true,
  true, true,
  true,
  true, true, true, true,
  false,
  true, true, false),

-- group_user: read-only view, no edit
('group_user',
  true, false, false, false,
  false, false, false,
  true, false,
  true, false,
  true, false,
  false, false,
  false,
  true, false, true, false,
  false,
  true, false, false),

-- dealer_admin: manages own dealership fully
('dealer_admin',
  true, true, true, true,
  true, true, true,
  true, true,
  true, true,
  true, true,
  true, true,
  true,
  false, false, false, false,
  false,
  true, true, false),

-- dealer_user: daily ops only
('dealer_user',
  true, false, false, false,
  true, true, true,
  true, false,
  true, false,
  false, false,
  false, false,
  false,
  false, false, false, false,
  false,
  false, true, false)

ON CONFLICT (role) DO NOTHING;
