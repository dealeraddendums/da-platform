-- Migration 070: ftp_users notes table for the FTP Server admin page.
--
-- Cerberus FTP Server (running on the Windows box at 34.193.4.78) is the
-- source of truth for FTP user accounts. The platform's /admin/ftp-server
-- page reads the live user list via Cerberus SOAP. This table only stores
-- per-username notes — free-form text the team adds for context (which
-- vendor a user belongs to, gotchas, ticket links, etc.). Mirrors the
-- legacy hub's `ftpnote` table.

CREATE TABLE IF NOT EXISTS public.ftp_users (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  username   text        UNIQUE NOT NULL,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ftp_users_username_idx ON public.ftp_users (username);

ALTER TABLE public.ftp_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ftp_users_super_admin" ON public.ftp_users FOR ALL
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'super_admin');

CREATE OR REPLACE FUNCTION public.ftp_users_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ftp_users_updated_at ON public.ftp_users;
CREATE TRIGGER ftp_users_updated_at
BEFORE UPDATE ON public.ftp_users
FOR EACH ROW EXECUTE FUNCTION public.ftp_users_touch_updated_at();
