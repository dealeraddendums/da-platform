-- 107_starter_templates.sql
-- Phase 1 of SuperAdmin Starter Layouts (docs/superadmin-starter-layouts.md).
--
-- A THIRD template scope: platform. `templates` is dealer-scoped (dealer_id NOT
-- NULL) and `group_templates` is group-scoped; starter layouts have no dealer or
-- group, so they get their own table (mirroring the scope:platform precedent in
-- lib/image-library.ts). Every dealer can start a new document from these.
--
-- RLS: SELECT for any authenticated user (all dealers list starters in +New);
-- writes are blocked at RLS — they go through the super_admin-gated API on the
-- service-role client (which bypasses RLS), so no INSERT/UPDATE/DELETE policy
-- exists (defense in depth: a row can never be written via a user client).
--
-- Apply via the Supabase SQL editor (primary DA project) — NOT from the box.

CREATE TABLE IF NOT EXISTS public.starter_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  doc_type      text NOT NULL CHECK (doc_type IN ('addendum', 'infosheet', 'buyers_guide')),
  paper         text NOT NULL,
  template_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order    int NOT NULL DEFAULT 0,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS starter_templates_doc_type_sort_idx
  ON public.starter_templates (doc_type, sort_order);

ALTER TABLE public.starter_templates ENABLE ROW LEVEL SECURITY;

-- Read: any authenticated user.
DROP POLICY IF EXISTS starter_templates_read ON public.starter_templates;
CREATE POLICY starter_templates_read ON public.starter_templates
  FOR SELECT
  USING (auth.role() = 'authenticated');

-- No INSERT/UPDATE/DELETE policy → all writes denied at RLS. Writes happen only
-- via the super_admin-gated API using the service-role admin client.
