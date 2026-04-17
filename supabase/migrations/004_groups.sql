-- Phase 3: groups table, dealer/profile FK wiring, updated JWT hook, RLS

-- ── Groups table ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.groups (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text        NOT NULL,
  active                boolean     NOT NULL DEFAULT true,
  primary_contact       text,
  primary_contact_email text,
  phone                 text,
  address               text,
  city                  text,
  state                 text,
  zip                   text,
  country               text        NOT NULL DEFAULT 'US',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS groups_name_idx   ON public.groups (name);
CREATE INDEX IF NOT EXISTS groups_active_idx ON public.groups (active);

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;

-- ── Wire dealers.group_id FK (column was added in 003 as unconstrained) ───────

ALTER TABLE public.dealers
  ADD CONSTRAINT dealers_group_id_fkey
  FOREIGN KEY (group_id) REFERENCES public.groups (id) ON DELETE SET NULL;

-- ── Add group_id to profiles ──────────────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES public.groups (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS profiles_group_id_idx ON public.profiles (group_id) WHERE group_id IS NOT NULL;

-- ── RLS: groups ───────────────────────────────────────────────────────────────

-- super_admin: full access
CREATE POLICY "groups_super_admin_all" ON public.groups
  FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin')
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin')
  );

-- group_admin: read own group
CREATE POLICY "groups_self_read" ON public.groups
  FOR SELECT
  USING (
    id = (SELECT p.group_id FROM public.profiles p WHERE p.id = auth.uid() LIMIT 1)
  );

-- group_admin: update own group
CREATE POLICY "groups_admin_update" ON public.groups
  FOR UPDATE
  USING (
    id = (SELECT p.group_id FROM public.profiles p
          WHERE p.id = auth.uid() AND p.role = 'group_admin' LIMIT 1)
  )
  WITH CHECK (
    id = (SELECT p.group_id FROM public.profiles p
          WHERE p.id = auth.uid() AND p.role = 'group_admin' LIMIT 1)
  );

-- ── RLS: dealers — add group_admin read policy ────────────────────────────────

-- group_admin can read all dealers in their group
CREATE POLICY "dealers_group_read" ON public.dealers
  FOR SELECT
  USING (
    group_id = (
      SELECT p.group_id FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role = 'group_admin' LIMIT 1
    )
  );

-- ── updated_at trigger ────────────────────────────────────────────────────────

CREATE OR REPLACE TRIGGER groups_updated_at
  BEFORE UPDATE ON public.groups
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── JWT hook: add group_id promotion ─────────────────────────────────────────
-- Re-registers the hook to also promote group_id from app_metadata.
-- No need to re-register in the dashboard — it's the same function name.

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  claims   jsonb;
  app_meta jsonb;
BEGIN
  claims   := event -> 'claims';
  app_meta := claims -> 'app_metadata';

  IF app_meta IS NOT NULL THEN
    IF app_meta ? 'role' THEN
      claims := jsonb_set(claims, '{role}', app_meta -> 'role');
    END IF;
    IF app_meta ? 'dealer_id' THEN
      claims := jsonb_set(claims, '{dealer_id}', app_meta -> 'dealer_id');
    END IF;
    IF app_meta ? 'group_id' THEN
      claims := jsonb_set(claims, '{group_id}', app_meta -> 'group_id');
    END IF;
  END IF;

  RETURN jsonb_set(event, '{claims}', claims);
END;
$$;

GRANT EXECUTE ON FUNCTION public.custom_access_token_hook TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook FROM PUBLIC;
