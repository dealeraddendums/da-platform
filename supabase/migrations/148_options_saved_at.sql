-- 148: dealer_vehicles.options_saved_at — explicit "options were saved" marker.
--
-- Root cause of the Napleton Transit mis-print (2026-08-18): the options save
-- is a full-replace (delete + insert), so saving an EMPTY set leaves zero
-- vehicle_options rows — indistinguishable from a never-saved vehicle. Every
-- read path (options GET matched previews, pdf/generate + pdf/bulk library
-- seed, feed export seed) then re-seeded the rules-matched library set,
-- resurrecting products the operator had explicitly deleted (Wheel Locks +
-- 3M printed and inflated the asking price by $973).
--
-- options_saved_at is stamped on EVERY options save (POST /api/options and
-- the save-on-print path). Read paths treat "zero rows but options_saved_at
-- set" as a deliberate saved-empty set: no seeding, no matched previews, no
-- legacy-'0'-sentinel fallback. NULL (all existing rows) keeps today's
-- behavior — vehicles with saved rows are already self-marking.
ALTER TABLE public.dealer_vehicles
  ADD COLUMN IF NOT EXISTS options_saved_at timestamptz;
