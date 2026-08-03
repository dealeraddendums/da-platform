-- Migration 137: widen invitations_role_check to all six platform roles.
--
-- The admin Users page "Send invite / reset email" action creates invitation
-- rows for ANY user, including super_admin (staff) — but the constraint from
-- migration 041 only allowed dealer + group roles, so a super_admin invite
-- insert was rejected by the DB. Same fix class as migration 125 (profiles).

ALTER TABLE public.invitations DROP CONSTRAINT IF EXISTS invitations_role_check;
ALTER TABLE public.invitations ADD CONSTRAINT invitations_role_check
  CHECK (role IN ('super_admin', 'group_admin', 'group_user', 'dealer_admin', 'dealer_user', 'dealer_restricted'));
