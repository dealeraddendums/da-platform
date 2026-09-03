-- 155: application auth-event log — "did user X log in, and from where?"
--
-- Why this exists: `auth.audit_log_entries` on this project has 0 rows and
-- always has. The cause is a platform setting, `audit_log_disable_postgres`,
-- which hosted Supabase reports as true and will not let us change (the
-- Management API accepts a PATCH with HTTP 200 and leaves the value at true).
-- So GoTrue's native audit trail is unavailable, and the 2026-09-03 fake-signup
-- forensics could not answer "did either account ever sign in" from the auth
-- layer — only by triangulating Mandrill opens, nginx paths and session rows,
-- and session rows cascade-delete with the user, so even that was inconclusive.
--
-- This table is ours: it survives user deletion (no FK to auth.users), it
-- records failures as well as successes, and it captures the IP and user-agent
-- of the request that made the attempt.
CREATE TABLE IF NOT EXISTS public.auth_events (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  at         timestamptz NOT NULL DEFAULT now(),

  -- Deliberately NOT a foreign key: the whole point is that this outlives a
  -- deleted account. Email is the durable identifier.
  email      text,
  user_id    uuid,

  -- otp_code_requested | otp_verify | passkey_verify | password_verify
  -- | invite_accept | impersonate | ghost_enter | signout
  event      text        NOT NULL,
  -- success | failure — failures are the interesting half.
  result     text        NOT NULL CHECK (result IN ('success','failure')),
  detail     text,

  ip         text,
  user_agent text,

  -- 'server' = recorded by a route that itself performed the verification, so
  -- it is authoritative. 'client' = reported by the browser after a
  -- Supabase-JS verify that happens client-side (OTP code, password). Client
  -- reports can be omitted or forged by a hostile client and must never be
  -- read as proof on their own — the IP and user-agent on them are still
  -- server-derived. Keeping the distinction visible stops a future
  -- investigation from over-trusting a row.
  source     text        NOT NULL DEFAULT 'server' CHECK (source IN ('server','client'))
);

CREATE INDEX IF NOT EXISTS auth_events_email_idx  ON public.auth_events (lower(email), at DESC);
CREATE INDEX IF NOT EXISTS auth_events_at_idx     ON public.auth_events (at DESC);
CREATE INDEX IF NOT EXISTS auth_events_ip_idx     ON public.auth_events (ip, at DESC);
CREATE INDEX IF NOT EXISTS auth_events_result_idx ON public.auth_events (result, at DESC) WHERE result = 'failure';

-- Service-role only; written by routes using the admin client.
ALTER TABLE public.auth_events ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.auth_events IS
  'Login attempts (success and failure) with IP + user-agent. Replaces the unavailable GoTrue auth.audit_log_entries. Pruned at 180 days by the purge cron.';
