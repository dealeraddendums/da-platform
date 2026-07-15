-- Migration 128: FTP Feed Export (V5.0 port of the DA 4.0 HUB Feeds section).
--
-- Feed companies (Homenet, DealersLink, Vincue, Autorevolution, ipacket, …)
-- receive a CSV of vehicles + addendum data via FTP/SFTP. super_admin-only
-- feature at /admin/feeds; all access goes through service-role API routes,
-- so RLS is enabled with no policies (same posture as admin_audit).

create table if not exists feed_companies (
  id          uuid default gen_random_uuid() primary key,
  name        text not null,  -- NOT unique — multiple exports to one provider are allowed
  ftp_url     text not null,
  ftp_username text not null,
  ftp_password text not null, -- stored as-is (parity with 4.0; service-role-only table)
  ftp_port    integer not null default 21,
  filename    text not null,  -- pushed as {filename}.csv
  protocol    text not null default 'ftp' check (protocol in ('ftp','sftp')),
  include_vehicles text not null default 'printed' check (include_vehicles in ('printed','all')),
  -- 'printed' = print_status=1 AND status='active'; 'all' = all status='active'
  column_mappings jsonb not null default '[]'::jsonb,
  -- shape: [{recipientColumn: string, daField: string}]
  last_push_at timestamptz,
  last_push_status text,      -- 'success' | error summary from the last push attempt
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create table if not exists feed_company_dealers (
  id                uuid default gen_random_uuid() primary key,
  feed_company_id   uuid not null references feed_companies(id) on delete cascade,
  -- V5.0 keys on the platform UUID (dealers.id), NOT the legacy dealer_id text key
  dealer_uuid       uuid not null references dealers(id) on delete cascade,
  feed_dealer_id    text not null,  -- dealer ID as known by the feed provider (any format)
  created_at        timestamptz default now(),
  unique (feed_company_id, dealer_uuid)
);

create index if not exists feed_company_dealers_feed_idx on feed_company_dealers (feed_company_id);

alter table feed_companies enable row level security;
alter table feed_company_dealers enable row level security;

comment on table feed_companies is
  'FTP/SFTP CSV feed export targets (Homenet, DealersLink, …). super_admin-only via /admin/feeds; service-role access only.';
