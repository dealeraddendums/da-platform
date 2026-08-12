-- 141 — Store tags at invite time (2026-08-12)
--
-- Group User (Regional Manager) invitations can carry the store-tag scope
-- the operator picked in the invite form. /api/invite/accept writes the
-- user_tags rows from this array right after the group_user profile is
-- created — no separate post-acceptance assignment step. NULL/empty = no
-- tags (user sees no dealers until tagged via the StoreTagsEditor).
-- Resend keeps the row (tags persist); revoke deletes the row (tags gone).
ALTER TABLE public.invitations
  ADD COLUMN IF NOT EXISTS scope_tag_ids uuid[] NULL;
