-- Migration 133: Fortellis Feed Integration (CDK PIP replacement — sunset 2026-10-23).
--
-- Fortellis (CDK's API platform) replaces the legacy CDK PIP extract. This adds:
--   1. fortellis_dealers   — one row per dealer connection (Marketplace subscription)
--   2. fortellis_api_log   — certification-grade request/response logging (Fortellis
--                            requires complete request+response logs, retained >=60 days,
--                            JWTs masked). Purged at >90 days by the PDF-purge cron.
--
-- super_admin-only feature at /admin/fortellis-dealers; all access goes through
-- service-role API routes, so RLS is enabled with NO policies (same posture as
-- admin_audit / feed_companies). Writes Supabase dealer_vehicles ONLY — never Aurora.
--
-- Phase 0 discovery finding (2026-07-18, from the authoritative MVS2 Developer Guide): the
-- API is the synchronous "CDK Drive Get Merchandisable Vehicles v2" search at
-- /{ns}/sales/inventory/v2/merchandisable-vehicles. Per-dealer scoping uses webId and/or
-- dealerCode (there is no Department-Id) — both captured below, optional.

create table if not exists fortellis_dealers (
  id                bigint generated always as identity primary key,
  dealer_name       text not null,
  subscription_id   text not null unique,          -- Fortellis Subscription-Id
  web_id            text,                           -- dealer's CDK webId (e.g. motp-…-cdkinv) — optional search scope
  dealer_code       text,                           -- CDK DMS dealerCode — optional search scope
  dealer_id         text,                           -- dealers.dealer_id (Supabase text key) — resolved at add time
  is_new            boolean not null default true,  -- parity with cdk_dealers.NEW: bulk install not yet run
  enabled           boolean not null default true,  -- excluded from hourly delta when false
  last_delta_at     timestamptz,                    -- per-dealer delta watermark
  last_full_sync_at timestamptz,
  last_status       text,                           -- 'ok' | error summary from the most recent run
  created_at        timestamptz not null default now()
);

-- Certification logging. response_body kept as text (payloads can be large); Authorization
-- is masked to "Bearer ####…" before storage (a Fortellis certification requirement).
create table if not exists fortellis_api_log (
  id              bigint generated always as identity primary key,
  at              timestamptz not null default now(),
  subscription_id text,
  method          text not null,
  url             text not null,
  request_id      text,                             -- Fortellis Request-Id header (support tickets)
  http_status     integer,
  duration_ms     integer,
  request_headers jsonb,                            -- Authorization MASKED
  response_body   text,                             -- complete payload (cert requirement)
  error           text
);

create index if not exists fortellis_api_log_at_idx on fortellis_api_log (at);
create index if not exists fortellis_dealers_dealer_id_idx on fortellis_dealers (dealer_id);

alter table fortellis_dealers enable row level security;
alter table fortellis_api_log enable row level security;
