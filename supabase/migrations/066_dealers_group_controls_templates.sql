-- Migration 066: group_controls_templates flag on dealers.
--
-- When true, the dealer's group_admin manages templates on their behalf:
--   • Builder nav item is hidden for dealer_admin / dealer_user /
--     dealer_restricted roles, and direct /builder requests are redirected.
--   • Print Settings → Default Templates dropdowns become read-only,
--     showing the current group-assigned template name plus a
--     "Template managed by your group admin" note.
--   • Printing still works normally — the group-assigned template is used.
-- Defaults false so existing dealers keep self-managing templates.

ALTER TABLE public.dealers
  ADD COLUMN IF NOT EXISTS group_controls_templates boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.dealers.group_controls_templates IS
  'When true, the dealer''s group_admin controls templates. Builder nav '
  'item is hidden and Default Templates are read-only for dealer roles. '
  'group_admin / super_admin always retain access regardless of this flag.';
