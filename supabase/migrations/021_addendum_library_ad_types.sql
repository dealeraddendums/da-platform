-- Migration 021: Add ad_types text[] to addendum_library
-- Replaces single-value ad_type ('New'|'Used'|'Both') with a multi-select array
-- so dealers can independently select New, Used, and CPO combinations.

ALTER TABLE public.addendum_library
  ADD COLUMN IF NOT EXISTS ad_types text[];

-- Populate ad_types from existing ad_type values for all current rows
UPDATE public.addendum_library
SET ad_types = CASE
  WHEN ad_type = 'New'  THEN ARRAY['New']::text[]
  WHEN ad_type = 'Used' THEN ARRAY['Used']::text[]
  ELSE ARRAY['New', 'Used']::text[]   -- 'Both' or any legacy value
END
WHERE ad_types IS NULL;
