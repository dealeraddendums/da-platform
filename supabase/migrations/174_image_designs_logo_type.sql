-- Migration 174 — Logo Composer (2026-10-09, Allan): allow Image Builder
-- designs of type 'logo' (1500×500 transparent PNG). The image_type CHECK from
-- migration 163 listed only the four background/infobox types.
--
-- Saved logos go to image_library with bucket 'new-dealer-logos' (the bucket IS
-- the category — so logos never appear in the Backgrounds list) at dealer or
-- group scope, per the migration-090 model. No other change.

ALTER TABLE public.image_designs DROP CONSTRAINT IF EXISTS image_designs_image_type_check;
ALTER TABLE public.image_designs ADD CONSTRAINT image_designs_image_type_check
  CHECK (image_type IN ('infobox', 'addendum_bg_standard', 'addendum_bg_narrow', 'infosheet_bg', 'logo'));
