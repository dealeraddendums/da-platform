-- Stage 2: extend group_options with the same rich product fields that
-- addendum_library has, so corporate products can carry full descriptions,
-- applies-to rules, vehicle filters, separators, and spaces.
-- DEFAULT values match addendum_library defaults so existing rows behave
-- exactly as they do today.

ALTER TABLE group_options
  ADD COLUMN IF NOT EXISTS description       text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS required          boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS applies_to        text NOT NULL DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS ad_type           text NOT NULL DEFAULT 'Both',
  ADD COLUMN IF NOT EXISTS ad_types          text[] DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS makes             text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS makes_not         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS models            text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS models_not        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS trims             text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS trims_not         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS body_styles       text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS year_condition    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS year_value        integer DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS miles_condition   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS miles_value       integer DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS msrp_condition    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS msrp1             integer DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS msrp2             integer DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS show_models_only  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS separator_above   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS separator_below   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS spaces            integer NOT NULL DEFAULT 0;

-- Backfill required from existing is_suggested: previously, is_suggested=true
-- meant a product offered to dealers (effectively "Suggested"); is_suggested=false
-- meant a corporate-prepended Required product. Mirror that mapping into the
-- new required column so behavior matches what the UI showed before the renames.
UPDATE group_options
   SET required = NOT COALESCE(is_suggested, false);
