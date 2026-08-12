-- 142 — Direct dealer scoping for group_users via hidden system tags (2026-08-12)
--
-- Operators now scope a Regional Manager by PICKING DEALERS directly instead of
-- pre-building named tags. Under the hood each group_user gets a private,
-- auto-managed tag (name "__scope:{user_id}", system=true) applied to exactly
-- the selected dealers — the group ∩ user_tags engine is completely unchanged.
--
-- system=true tags are an implementation detail: excluded from /api/tags,
-- dealer profile tag chips/pickers, the dealers-list tag filter, and the
-- named-tag sections of the Store Tags editors. The dealer-profile tags PUT
-- preserves system rows (its picker can't see them, so a replace must not
-- wipe them).
ALTER TABLE public.tags
  ADD COLUMN IF NOT EXISTS system boolean NOT NULL DEFAULT false;

-- Invitations can carry a direct dealer selection (alongside the optional
-- named-tag scope from migration 141). /api/invite/accept materializes the
-- system tag + dealer_tags + user_tags link right after the group_user
-- profile is created.
ALTER TABLE public.invitations
  ADD COLUMN IF NOT EXISTS scope_dealer_ids uuid[] NULL;
