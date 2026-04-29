-- Feature 1: active_dealer_id on profiles (group_admin dealer context)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS active_dealer_id uuid REFERENCES public.dealers(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.profiles.active_dealer_id IS
  'group_admin only — UUID of the dealer they are currently viewing in dealer context';

-- Feature 3: invitation tokens for dealer staff email invites
CREATE TABLE IF NOT EXISTS public.invitations (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  token       text        UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
  email       text        NOT NULL,
  first_name  text        NOT NULL,
  last_name   text        NOT NULL,
  role        text        NOT NULL CHECK (role IN ('dealer_admin', 'dealer_user', 'dealer_restricted')),
  dealer_id   uuid        NOT NULL REFERENCES public.dealers(id) ON DELETE CASCADE,
  dealer_name text,
  invited_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz DEFAULT now(),
  expires_at  timestamptz DEFAULT (now() + interval '7 days'),
  accepted_at timestamptz
);

CREATE INDEX IF NOT EXISTS invitations_token_idx ON public.invitations (token);
CREATE INDEX IF NOT EXISTS invitations_email_idx ON public.invitations (email);

ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;

-- All invite operations go through the admin client (bypasses RLS).
-- Add a catch-all deny policy so direct client access is blocked.
CREATE POLICY "invitations_deny_direct"
  ON public.invitations FOR ALL
  USING (false);
