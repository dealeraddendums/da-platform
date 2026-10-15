-- 176: per-dealer "CPO by mileage & brand" rule for the INFOSHEET template.
--
-- A dealer can have USED vehicles of the brands they represent, under a mileage
-- cap, print their CPO Infosheet template, as well as vehicles the feed marks
-- certified. Template SELECTION only (lib/template-resolver.ts, infosheet doc
-- type only); it never writes the certified flag or the vehicle's condition,
-- and the addendum keeps resolving on the certified flag alone.
--
--   cpo_by_mileage_enabled  the switch; false = today's behaviour
--   cpo_by_mileage_cap      used vehicles with 0 < mileage < cap qualify
--   cpo_by_mileage_brands   make keys (lib/make-key.ts makeKey(): uppercase,
--                           alphanumerics only, e.g. {FORD,LINCOLN})
-- A missing cap or an empty brand list leaves the rule inert.

ALTER TABLE public.dealer_settings
  ADD COLUMN IF NOT EXISTS cpo_by_mileage_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cpo_by_mileage_cap integer,
  ADD COLUMN IF NOT EXISTS cpo_by_mileage_brands text[];
