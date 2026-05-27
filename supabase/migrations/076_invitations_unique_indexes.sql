-- Migration 076: unique indexes on invitations for ON CONFLICT upserts
--
-- /api/invite, /api/dealers/[id]/users, and /api/groups/[id]/users all call
-- .upsert(..., { onConflict: "email,dealer_id" }) or "email,group_id" so a
-- second invite to the same address rotates the token instead of inserting a
-- duplicate. PostgREST forwards the ON CONFLICT spec verbatim to Postgres,
-- which then requires a matching unique constraint or unique index. Without
-- it, every invite POST fails with:
--
--   "there is no unique or exclusion constraint matching the ON CONFLICT
--    specification"
--
-- Migration 040 created the invitations table with non-unique indexes on
-- token (unique) and email (non-unique) only. 041 made dealer_id nullable
-- and added group_id (also nullable) for group invites. We add two PARTIAL
-- unique indexes — one per invite scope — so:
--   - dealer invites enforce (email, dealer_id) uniqueness only when
--     dealer_id IS NOT NULL
--   - group invites enforce (email, group_id) uniqueness only when
--     group_id IS NOT NULL
--
-- Postgres can use a partial unique index for ON CONFLICT inference when
-- the row being inserted satisfies the partial-index WHERE predicate, which
-- is true on every invite path (dealer_id or group_id is always set, never
-- both NULL).

CREATE UNIQUE INDEX IF NOT EXISTS invitations_email_dealer_uidx
  ON public.invitations (email, dealer_id)
  WHERE dealer_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS invitations_email_group_uidx
  ON public.invitations (email, group_id)
  WHERE group_id IS NOT NULL;
