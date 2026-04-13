-- Phase 1: users table + RLS
-- Run this in the Supabase SQL editor or via `supabase db push`

CREATE TABLE IF NOT EXISTS public.users (
  id          uuid        PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  dealer_id   text        NOT NULL,
  user_type   text        NOT NULL CHECK (
    user_type IN (
      'root_admin',
      'reseller_admin',
      'reseller_user',
      'group_admin',
      'group_user',
      'group_user_restricted',
      'dealer'
    )
  ),
  email       text        NOT NULL,
  name        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Index for the most common query pattern (dealer isolation)
CREATE INDEX IF NOT EXISTS users_dealer_id_idx ON public.users (dealer_id);

-- Enable RLS
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- Dealer isolation policy:
-- Users can only read rows where dealer_id matches their JWT claim.
-- root_admin bypasses this via the service-role client in admin routes.
CREATE POLICY "dealer_isolation" ON public.users
  USING (dealer_id = (auth.jwt() ->> 'dealer_id'));

-- Allow each authenticated user to read their own row regardless of dealer
-- (used during login to bootstrap the session).
CREATE POLICY "self_read" ON public.users
  FOR SELECT
  USING (id = auth.uid());

-- Allow authenticated users to insert within their own dealer_id
CREATE POLICY "dealer_insert" ON public.users
  FOR INSERT
  WITH CHECK (dealer_id = (auth.jwt() ->> 'dealer_id'));

-- Allow authenticated users to update within their own dealer_id
CREATE POLICY "dealer_update" ON public.users
  FOR UPDATE
  USING (dealer_id = (auth.jwt() ->> 'dealer_id'));

-- Allow authenticated users to delete within their own dealer_id
CREATE POLICY "dealer_delete" ON public.users
  FOR DELETE
  USING (dealer_id = (auth.jwt() ->> 'dealer_id'));
