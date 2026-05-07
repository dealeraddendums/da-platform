-- Part 1: Required vs Suggested options
-- Adds required boolean to vehicle_options, addendum_library, and addendum_data.
-- DEFAULT true preserves all existing options as "required" — zero behavior change for current data.

ALTER TABLE vehicle_options
  ADD COLUMN IF NOT EXISTS required boolean NOT NULL DEFAULT true;

ALTER TABLE addendum_library
  ADD COLUMN IF NOT EXISTS required boolean NOT NULL DEFAULT true;

ALTER TABLE addendum_data
  ADD COLUMN IF NOT EXISTS required boolean NOT NULL DEFAULT true;
