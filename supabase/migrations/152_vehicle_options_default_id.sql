-- 152: vehicle_options.default_id — stable library identity for saved snapshots.
--
-- Until now a saved `source='default'` row was tied to its addendum_library
-- product by NAME alone. That made a LIBRARY RENAME indistinguishable from a
-- LIBRARY DELETE: pruneOrphanedDefaultRows (migration-era 2026-08-31, built to
-- stop deleted products from printing) dropped every saved row whose name no
-- longer matched, so renaming a product silently removed it from the PDF and
-- the editor on every vehicle that had already saved it — 64 Dickson City
-- Hyundai vehicles lost a $4,995 line that way, plus 11 more across Atlantic
-- Coast Acura, Benton Nissan of Columbia and ESCUDE Nissan of Greer.
--
-- With a stable id the two cases separate cleanly:
--   default_id present and still in the dealer's library -> keep (rename is fine)
--   default_id present and NOT in the library            -> prune (real delete)
--   default_id NULL                                      -> fall back to the
--                                                           name check (legacy
--                                                           rows, and rows whose
--                                                           name is ambiguous)
--
-- Deliberately NO foreign key: the prune already treats "id not in the live
-- library" as deleted, and an FK would either block library deletes or rewrite
-- history via ON DELETE SET NULL. Nullable by design — the name fallback covers
-- every row that cannot be resolved.
ALTER TABLE public.vehicle_options
  ADD COLUMN IF NOT EXISTS default_id uuid;

CREATE INDEX IF NOT EXISTS vehicle_options_default_id_idx
  ON public.vehicle_options (default_id);

COMMENT ON COLUMN public.vehicle_options.default_id IS
  'addendum_library.id this source=default snapshot came from. NULL = unresolved; readers fall back to matching by option_name.';

-- Backfill: only where the normalized name resolves to EXACTLY ONE library row
-- for that dealer. Ambiguous names (the same product listed twice, e.g. a
-- New/Used pair) stay NULL and keep using the name path, which already works
-- for them because the name still matches.
WITH norm AS (
  SELECT
    vo.id AS vo_id,
    lower(btrim(regexp_replace(regexp_replace(vo.option_name, '<[^>]*>', '', 'g'), '\s+', ' ', 'g'))) AS key,
    vo.dealer_id
  FROM public.vehicle_options vo
  WHERE vo.source = 'default' AND vo.default_id IS NULL
), lib AS (
  SELECT
    al.dealer_id,
    lower(btrim(regexp_replace(regexp_replace(al.option_name, '<[^>]*>', '', 'g'), '\s+', ' ', 'g'))) AS key,
    min(al.id::text) AS lib_id,
    count(*) AS n
  FROM public.addendum_library al
  GROUP BY 1, 2
)
UPDATE public.vehicle_options vo
SET default_id = lib.lib_id::uuid
FROM norm
JOIN lib ON lib.dealer_id = norm.dealer_id AND lib.key = norm.key AND lib.n = 1
WHERE vo.id = norm.vo_id;
