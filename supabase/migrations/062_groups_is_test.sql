-- Migration 062: is_test flag for groups
--
-- Same pattern as migration 060 for dealers: marks a group as a test
-- account, which is the *only* condition under which DELETE /api/groups/[id]
-- will hard-delete the group. Real customer groups must use the
-- Active/Inactive toggle. Setting / unsetting is_test is super_admin only.
--
-- Default false so every existing group is immediately protected.

ALTER TABLE public.groups
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.groups.is_test IS
  'When true, this group can be hard-deleted via the Delete Group button '
  '(super_admin only). Member dealers are disassociated, not deleted.';

CREATE INDEX IF NOT EXISTS groups_is_test_idx
  ON public.groups (is_test) WHERE is_test = true;
