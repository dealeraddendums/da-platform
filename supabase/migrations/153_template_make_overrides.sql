-- 153: per-MAKE template overrides.
--
-- Why: a rooftop that sells two brands from one parent — Hyundai + Genesis,
-- Jaguar + Land Rover, BMW + Mini — has ONE dealer_id and therefore one set of
-- per-condition default templates, so the premium brand prints on the
-- mainstream brand's (or a co-branded) addendum. Genesis in particular is
-- contractually its own identity. 33 active dealers are in this shape today
-- (23 Hyundai+Genesis, 6 Jaguar+Land Rover, 5 BMW+Mini), 22 of them inside a
-- group. The rest of the fleet is unaffected.
--
-- Shape: a LIST, not more columns on dealer_settings. 1,694 of 2,026 active
-- dealers have no dealer_settings row at all, and a dealer may want several
-- make rules; a side table keeps the feature additive and sparse.
CREATE TABLE IF NOT EXISTS public.template_make_overrides (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ON UPDATE CASCADE: dealer_id renames DO happen (Aurora feed-id changes) and
  -- the documented cascade relies on FK'd tables following the parent.
  dealer_id   text        NOT NULL REFERENCES public.dealers(dealer_id) ON DELETE CASCADE ON UPDATE CASCADE,
  -- Canonical make key: UPPERCASE with every non-alphanumeric stripped, so the
  -- six real spellings of Land Rover ("Land Rover", "LAND ROVER", "LANDROVER",
  -- "LandRover", "land rover", "Land Rover ") all become LANDROVER. Matched as a
  -- PREFIX of the vehicle's key, which also catches MINI COOPER -> MINI and
  -- BMW 5 SERIES -> BMW. Keep in sync with lib/make-key.ts.
  make_key    text        NOT NULL CHECK (make_key = upper(make_key) AND make_key <> ''),
  condition   text        NOT NULL DEFAULT 'any' CHECK (condition IN ('new','used','cpo','any')),
  doc_type    text        NOT NULL DEFAULT 'addendum' CHECK (doc_type IN ('addendum','infosheet')),
  -- May reference `templates` OR `group_templates` — deliberately no FK, exactly
  -- like dealer_settings.default_* since migration 065. The resolver tries
  -- dealer templates first, then group templates.
  template_id uuid        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dealer_id, make_key, condition, doc_type)
);

CREATE INDEX IF NOT EXISTS template_make_overrides_dealer_idx
  ON public.template_make_overrides (dealer_id, doc_type);

DROP TRIGGER IF EXISTS set_updated_at ON public.template_make_overrides;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.template_make_overrides
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Service-role only; every reader/writer goes through an authenticated route
-- with the admin client (same posture as feed_exclusion_rules).
ALTER TABLE public.template_make_overrides ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.template_make_overrides IS
  'Per-make template overrides. Empty table = every dealer resolves exactly as before.';
