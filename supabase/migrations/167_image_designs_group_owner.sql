-- Migration 167 — Group Image Builder (group-owned designs)
--
-- A design is owned by the platform (group_id NULL — staff designs and the
-- seeded starter templates, unchanged) or by ONE group. Group designs are
-- edited by that group's group_admin / group_user (and super_admin); their
-- exports land in the group's image library (image_library scope='group').
-- Groups get no starter templates (Allan, 2026-10-07), so a group design is
-- never a template.
--
-- App access goes through the service-role client with server-side scope
-- checks (lib/image-builder/access.ts); the policies are defense-in-depth.

ALTER TABLE public.image_designs
  ADD COLUMN IF NOT EXISTS group_id uuid NULL REFERENCES public.groups(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS image_designs_group_idx
  ON public.image_designs (group_id) WHERE group_id IS NOT NULL;

ALTER TABLE public.image_designs
  ADD CONSTRAINT image_designs_single_owner CHECK (dealer_uuid IS NULL OR group_id IS NULL);

ALTER TABLE public.image_designs
  ADD CONSTRAINT image_designs_group_not_template CHECK (group_id IS NULL OR is_template = false);

DROP POLICY IF EXISTS image_designs_group ON public.image_designs;
CREATE POLICY image_designs_group ON public.image_designs
  FOR ALL
  USING (group_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.role IN ('group_admin', 'group_user') AND p.group_id = image_designs.group_id))
  WITH CHECK (group_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.role IN ('group_admin', 'group_user') AND p.group_id = image_designs.group_id));

DROP POLICY IF EXISTS image_design_versions_group ON public.image_design_versions;
CREATE POLICY image_design_versions_group ON public.image_design_versions
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.image_designs d JOIN public.profiles p ON p.id = auth.uid()
    WHERE d.id = image_design_versions.design_id AND d.group_id IS NOT NULL
      AND p.role IN ('group_admin', 'group_user') AND p.group_id = d.group_id))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.image_designs d JOIN public.profiles p ON p.id = auth.uid()
    WHERE d.id = image_design_versions.design_id AND d.group_id IS NOT NULL
      AND p.role IN ('group_admin', 'group_user') AND p.group_id = d.group_id));
