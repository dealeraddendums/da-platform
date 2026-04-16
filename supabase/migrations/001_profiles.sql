-- Phase 1: profiles table + RLS + auto-create trigger
-- Replaces 001_users_table.sql (that spec was superseded)

CREATE TABLE IF NOT EXISTS public.profiles (
  id          uuid        PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  email       text        NOT NULL,
  full_name   text,
  role        text        NOT NULL DEFAULT 'dealer_user'
                          CHECK (role IN ('super_admin', 'group_admin', 'dealer_admin', 'dealer_user')),
  dealer_id   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS profiles_dealer_id_idx ON public.profiles (dealer_id);
CREATE INDEX IF NOT EXISTS profiles_role_idx ON public.profiles (role);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Users can read their own profile
CREATE POLICY "profiles_self_read" ON public.profiles
  FOR SELECT USING (id = auth.uid());

-- Users can update their own profile
CREATE POLICY "profiles_self_update" ON public.profiles
  FOR UPDATE USING (id = auth.uid());

-- super_admin can read all profiles (uses service-role client in API routes)
-- Dealer isolation for dealer_admin / dealer_user reading same-dealer users
CREATE POLICY "profiles_dealer_read" ON public.profiles
  FOR SELECT
  USING (
    dealer_id IS NOT NULL
    AND dealer_id = (
      SELECT p.dealer_id FROM public.profiles p
      WHERE p.id = auth.uid()
      LIMIT 1
    )
  );

-- Trigger: auto-create profile row when a new auth user is created
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    COALESCE(new.raw_app_meta_data ->> 'role', 'dealer_user')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN new;
END;
$$;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- updated_at auto-update
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();
