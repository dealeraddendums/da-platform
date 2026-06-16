-- 102: distinguish migration self-serve invites from user-signup invites.
-- Apply in the Supabase SQL editor, then deploy. Phase 13a.1.
--
-- Both kinds share the `invitations` table (scanner-proof setup_code_hash + token
-- pattern). `purpose` lets the /migrate verify accept only migration invites and
-- the /signup accept reject them — so a migration token can't be consumed by the
-- user-signup flow (and vice versa). Default 'user' keeps every existing row a
-- normal signup invite.

ALTER TABLE public.invitations
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'user';  -- 'user' | 'migration'
