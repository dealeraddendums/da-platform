-- Corporate-product assignment scope: a product can target every current and
-- future dealer in the group ("All Dealers in Group") OR a hand-picked subset
-- via dealer_option_assignments rows ("Select Dealers").
--
-- Pre-migration the engine used is_suggested as the implicit scope: Required
-- products always went to every dealer; Suggested products only went to
-- dealers with an explicit assignment row. We now decouple scope from type so
-- a Required product can also be limited to specific dealers and a Suggested
-- product can be made universal.

ALTER TABLE group_options
  ADD COLUMN IF NOT EXISTS assign_all_dealers boolean NOT NULL DEFAULT true;

-- Backfill existing rows to preserve the old behavior exactly:
--   - is_suggested=false (Required) → assign_all_dealers=true (every dealer)
--   - is_suggested=true  (Suggested) → assign_all_dealers=false (use rows)
-- DEFAULT true already covers Required; flip Suggested rows explicitly.
UPDATE group_options
   SET assign_all_dealers = false
 WHERE is_suggested = true;
