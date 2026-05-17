-- Migration 065: drop FK constraints on dealer_settings.default_* template
-- columns so they can hold UUIDs from either `templates` or `group_templates`.
--
-- Background: migration 031 added these columns with `REFERENCES templates(id)
-- ON DELETE SET NULL`. With the new group-templates-in-dealer-builder flow,
-- a dealer can now pick a group_template as their default and the FK rejects
-- the insert. The PDF resolver looks up the chosen UUID in `templates` first
-- and falls through to `group_templates` (handled in app code), so the FK is
-- the only thing left blocking the assignment.
--
-- ON DELETE SET NULL behavior is replaced by application-level cleanup
-- (group_templates deletes are infrequent; orphaned ids just render the
-- default fallback layout, which is benign).

ALTER TABLE public.dealer_settings DROP CONSTRAINT IF EXISTS dealer_settings_default_addendum_new_fkey;
ALTER TABLE public.dealer_settings DROP CONSTRAINT IF EXISTS dealer_settings_default_addendum_used_fkey;
ALTER TABLE public.dealer_settings DROP CONSTRAINT IF EXISTS dealer_settings_default_addendum_cpo_fkey;
ALTER TABLE public.dealer_settings DROP CONSTRAINT IF EXISTS dealer_settings_default_infosheet_new_fkey;
ALTER TABLE public.dealer_settings DROP CONSTRAINT IF EXISTS dealer_settings_default_infosheet_used_fkey;
ALTER TABLE public.dealer_settings DROP CONSTRAINT IF EXISTS dealer_settings_default_infosheet_cpo_fkey;
