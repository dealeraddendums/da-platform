-- Migration 018: Add applies_to column to addendum_library
-- Values: 'all' (auto-apply to all matching vehicles, default),
--         'rules' (auto-apply only to vehicles matching the rules),
--         'none' (never auto-apply; available in library picker for manual add)

ALTER TABLE public.addendum_library
  ADD COLUMN applies_to text NOT NULL DEFAULT 'all'
    CHECK (applies_to IN ('all', 'rules', 'none'));
