CREATE TABLE IF NOT EXISTS public.admin_audit (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id  uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action         text        NOT NULL,
  target_dealer_id text,
  metadata       jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX admin_audit_admin_user_id_idx ON public.admin_audit (admin_user_id);
CREATE INDEX admin_audit_created_at_idx    ON public.admin_audit (created_at DESC);

ALTER TABLE public.admin_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "super_admin_all" ON public.admin_audit
  FOR ALL TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'super_admin');
