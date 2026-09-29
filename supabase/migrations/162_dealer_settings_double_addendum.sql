-- Print Double Addendums — an OPTIONAL second addendum template per condition.
--
-- When print_double_addendums is on and a *_second template is set for the
-- vehicle's condition, the print pipeline renders that template too and merges
-- it into the SAME PDF behind the primary. One vehicle still produces one PDF
-- and one recorded print — the second template adds a page, not a print.
--
-- Column shape deliberately mirrors default_addendum_{new,used,cpo} AFTER
-- migration 065: uuid, nullable, and NO foreign key. The id may reference
-- either public.templates OR public.group_templates (065 dropped the FK for
-- exactly that reason), so re-adding one here would reject every group
-- template and silently fail the write the way the 1288c7a assign-modal bug
-- did. lib/template-resolver.ts resolves the id against both tables.
--
-- Blank (NULL) = no second addendum for that condition, which is the default
-- for every existing row. Unchecking the box hides the pickers in the UI but
-- keeps the stored ids, so a dealer can toggle the feature off and back on
-- without re-selecting templates.

ALTER TABLE public.dealer_settings
  ADD COLUMN IF NOT EXISTS print_double_addendums    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS default_addendum_new_second  uuid NULL,
  ADD COLUMN IF NOT EXISTS default_addendum_used_second uuid NULL,
  ADD COLUMN IF NOT EXISTS default_addendum_cpo_second  uuid NULL;

COMMENT ON COLUMN public.dealer_settings.print_double_addendums IS
  'When true, a vehicle whose condition has a *_second addendum template set prints both templates merged into one PDF (primary first). Counts as ONE print.';
COMMENT ON COLUMN public.dealer_settings.default_addendum_new_second IS
  'Optional SECOND addendum template for New vehicles. uuid into templates OR group_templates (no FK — see migration 065). NULL = no second addendum.';
COMMENT ON COLUMN public.dealer_settings.default_addendum_used_second IS
  'Optional SECOND addendum template for Used vehicles. uuid into templates OR group_templates (no FK — see migration 065). NULL = no second addendum.';
COMMENT ON COLUMN public.dealer_settings.default_addendum_cpo_second IS
  'Optional SECOND addendum template for CPO vehicles. uuid into templates OR group_templates (no FK — see migration 065). NULL = no second addendum.';
