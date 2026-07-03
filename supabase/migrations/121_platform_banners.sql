-- Migration 121 — platform_banners
-- SuperAdmin-authored platform-wide banner messages (holiday hours, service
-- disruption notices, etc.) shown at the top of the app for all users within a
-- start/end window.
--
-- Apply in the Supabase SQL editor (Dashboard → SQL editor → Run). The prod EC2
-- box has no direct Postgres access, so DDL is not applied from the box.

CREATE TABLE IF NOT EXISTS platform_banners (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  message     text        NOT NULL,
  banner_type text        NOT NULL DEFAULT 'info',  -- 'info' | 'warning' | 'success' | 'error'
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz,                           -- NULL = no expiry
  created_by  uuid        REFERENCES profiles(id),
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- Fast lookup of the currently-active banner.
CREATE INDEX IF NOT EXISTS platform_banners_window_idx
  ON platform_banners (starts_at DESC, ends_at);

ALTER TABLE platform_banners ENABLE ROW LEVEL SECURITY;

-- super_admin: full read/write.
DROP POLICY IF EXISTS "super_admin only" ON platform_banners;
CREATE POLICY "super_admin only" ON platform_banners
  USING (auth.jwt() ->> 'role' = 'super_admin')
  WITH CHECK (auth.jwt() ->> 'role' = 'super_admin');

-- Everyone: read only banners that are currently within their active window.
DROP POLICY IF EXISTS "read active banners" ON platform_banners;
CREATE POLICY "read active banners" ON platform_banners
  FOR SELECT
  USING (
    starts_at <= now()
    AND (ends_at IS NULL OR ends_at >= now())
  );
