-- Migration 163 — Image Builder (Illustrator replacement)
--
-- Staff design the Image Library's flat PNGs in-app. A design is JSON; the
-- rendered PNG still lands in image_library through the existing upload path.
-- The Image Builder is NEVER in the print path — nothing here is read by PDF
-- generation.
--
-- App access goes through the service-role client (bypasses RLS); the policies
-- below are defense-in-depth. Dealer self-service is OFF (feature flag) — its
-- dealer-scoped policies ship with that ticket, not here.

-- ── Per-user grant ───────────────────────────────────────────────────────────
-- super_admin implies it; everyone else needs it explicitly. Launch: nobody.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_use_image_builder boolean NOT NULL DEFAULT false;

-- ── Designs ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.image_designs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = DA global/staff design (incl. seeded starter templates)
  dealer_uuid       uuid NULL REFERENCES public.dealers(id) ON DELETE CASCADE,
  image_type        text NOT NULL CHECK (image_type IN (
                      'infobox',
                      'addendum_bg_standard',
                      'addendum_bg_narrow',
                      'infosheet_bg')),
  name              text NOT NULL,
  design_json       jsonb NOT NULL,
  is_template       boolean NOT NULL DEFAULT false,
  -- the library image this design last rendered to
  exported_image_id uuid NULL REFERENCES public.image_library(id) ON DELETE SET NULL,
  -- the old (Illustrator) library image this design recreates → obsolete tracking
  replaces_image_id uuid NULL REFERENCES public.image_library(id) ON DELETE SET NULL,
  created_by        uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS image_designs_dealer_idx   ON public.image_designs (dealer_uuid);
CREATE INDEX IF NOT EXISTS image_designs_type_idx     ON public.image_designs (image_type);
CREATE INDEX IF NOT EXISTS image_designs_replaces_idx ON public.image_designs (replaces_image_id)
  WHERE replaces_image_id IS NOT NULL;

-- ── Version history (every save writes one) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.image_design_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  design_id   uuid NOT NULL REFERENCES public.image_designs(id) ON DELETE CASCADE,
  version_no  integer NOT NULL,
  design_json jsonb NOT NULL,
  saved_by    uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  saved_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (design_id, version_no)
);

CREATE INDEX IF NOT EXISTS image_design_versions_design_idx
  ON public.image_design_versions (design_id, version_no DESC);

-- ── RLS: staff (super_admin or granted) full access ──────────────────────────
ALTER TABLE public.image_designs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.image_design_versions  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS image_designs_staff ON public.image_designs;
CREATE POLICY image_designs_staff ON public.image_designs
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND (p.role = 'super_admin' OR p.can_use_image_builder)))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND (p.role = 'super_admin' OR p.can_use_image_builder)));

DROP POLICY IF EXISTS image_design_versions_staff ON public.image_design_versions;
CREATE POLICY image_design_versions_staff ON public.image_design_versions
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND (p.role = 'super_admin' OR p.can_use_image_builder)))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND (p.role = 'super_admin' OR p.can_use_image_builder)));
