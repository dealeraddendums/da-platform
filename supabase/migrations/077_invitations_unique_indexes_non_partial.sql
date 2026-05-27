-- Migration 077: replace 076's partial unique indexes with non-partial ones
--
-- 076 created PARTIAL unique indexes
--   (email, dealer_id) WHERE dealer_id IS NOT NULL
--   (email, group_id)  WHERE group_id  IS NOT NULL
--
-- but Postgres can only infer a partial unique index as the ON CONFLICT
-- arbiter when the INSERT carries the matching WHERE predicate (e.g.
-- `ON CONFLICT (email, dealer_id) WHERE dealer_id IS NOT NULL`). PostgREST's
-- upsert path (supabase-js .upsert(..., { onConflict: "email,dealer_id" }))
-- emits plain `ON CONFLICT (email, dealer_id)` with no predicate, so the
-- partial indexes from 076 don't match and every invite POST still fails
-- with "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification".
--
-- Non-partial unique indexes work because Postgres treats NULL as distinct
-- by default — the (email, dealer_id) index still allows unlimited group
-- invites (dealer_id IS NULL is never equal to itself), and the
-- (email, group_id) index allows unlimited dealer invites the same way.

DROP INDEX IF EXISTS public.invitations_email_dealer_uidx;
DROP INDEX IF EXISTS public.invitations_email_group_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS invitations_email_dealer_uidx
  ON public.invitations (email, dealer_id);

CREATE UNIQUE INDEX IF NOT EXISTS invitations_email_group_uidx
  ON public.invitations (email, group_id);
