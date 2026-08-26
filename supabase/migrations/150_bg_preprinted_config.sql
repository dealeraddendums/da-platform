-- Migration 150: Buyer's Guide pre-printed-label mode (2026-08-25)
--
-- Dealers who print Buyer's Guides on their OWN pre-printed FTC label stock
-- (first case: AutoNation Audi of Fremont) need DA to print ONLY the variable
-- data, positioned to land in the label's pre-printed boxes. Per-dealer
-- config (jsonb):
--   { "enabled": bool,
--     "global": {"x": pts, "y": pts},                 -- overall registration
--     "fields": {"vin": {"x":2,"y":-1}, ...},         -- per-field nudges
--     "language": "en"|"es", "note": "..." }
-- Offsets are PDF points relative to the calibrated default coordinates;
-- the variable-field SET never changes (compliance) — repositioning only.
-- NULL / enabled=false = full-FTC-background behavior (default, unchanged).

ALTER TABLE public.dealer_settings
  ADD COLUMN IF NOT EXISTS bg_preprinted_config jsonb;

COMMENT ON COLUMN public.dealer_settings.bg_preprinted_config IS
  'Buyer''s Guide pre-printed-label mode: {enabled, global:{x,y}, fields:{key:{x,y}}, language, note}. Data-only render at default coords + offsets when enabled.';
