-- 179_crm_foundation.sql — DA-CRM Phase 1: foundation, companies, team, Dialpad.
--
-- DA-CRM replaces HubSpot's CRM / ticketing / workflow role. Phases:
-- Dialpad (1) → Inbox (2) → Chat (3) → Tickets (4) → Tasks (5) → Workflows (6)
-- → Automations (7). This migration is the backbone every later phase builds on.
--
--   staff_permissions        'crm' (normal access) / 'crm_admin' (team + ownership)
--   crm_settings             one row: platform name ("DA-CRM") + logo
--   crm_companies            ONE row per dealer / group (pointer, never a copy)
--                            + vendors and feed suppliers that only live here
--   crm_brands               standard US franchise brand list (seeded)
--   crm_company_brands       a dealer's brands (multi-select)
--   crm_company_files        attachments (feed-request PDFs, …) in S3
--   crm_contacts             people at a company (optionally a platform user)
--   crm_staff_profiles       the DA team: team, capabilities, hours, Dialpad user
--   crm_activities           THE single timeline every module writes to
--   crm_calls                Dialpad call detail, 1:1 with a 'call' activity
--   crm_tickets / crm_tasks  stubs (UI in phases 4 / 5)
--   crm_dialpad_events       raw Dialpad webhook log (debug / replay)
--   crm_webhook_subscriptions / crm_webhook_deliveries  outbound events (da-billing)
--
-- Dealer and group rows are keyed by their existing Supabase UUIDs; names,
-- addresses and account state are always read from dealers / groups, never
-- duplicated. Additive only — the only touches on existing tables are AFTER
-- INSERT triggers on dealers / groups (auto-create the company row) and an
-- expression index on dealers(phone) for call matching.
--
-- Vocabulary: no sales terms anywhere (no deal / lead / prospect). Dealer
-- pipeline is trial → setup_training → paying, plus cancelled / lost.
--
-- Unmatched calls: an activity / call with company_id IS NULL is the
-- "Unmatched" bucket on the Calls page until staff assign it.

-- ── Staff permissions ────────────────────────────────────────────────────────
-- A permission only counts for an ACTIVE super_admin, so a stray row can never
-- open a staff tool to a dealer or group login.
create table if not exists public.staff_permissions (
  user_id     uuid        not null references public.profiles(id) on delete cascade,
  permission  text        not null check (permission ~ '^[a-z][a-z0-9_]*$'),
  granted_by  uuid        references public.profiles(id) on delete set null,
  granted_at  timestamptz not null default now(),
  primary key (user_id, permission)
);
alter table public.staff_permissions enable row level security;

create or replace function public.has_staff_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.staff_permissions sp
    join public.profiles pr on pr.id = sp.user_id
    where sp.user_id = auth.uid()
      -- crm_admin implies crm (same rule as lib/crm/access.ts).
      and (sp.permission = p_permission or (p_permission = 'crm' and sp.permission = 'crm_admin'))
      and pr.role = 'super_admin'
      and pr.active
  );
$$;

drop policy if exists staff_permissions_self_read on public.staff_permissions;
create policy staff_permissions_self_read on public.staff_permissions
  for select using (user_id = auth.uid() or public.has_staff_permission('crm_admin'));
drop policy if exists staff_permissions_admin_write on public.staff_permissions;
create policy staff_permissions_admin_write on public.staff_permissions
  for all using (public.has_staff_permission('crm_admin')) with check (public.has_staff_permission('crm_admin'));

-- Seed: the protected team (088's list) gets DA-CRM; Allan is the first admin.
insert into public.staff_permissions (user_id, permission)
select id, 'crm' from public.profiles
where lower(email) = any (array[
  'allan@dealeraddendums.com',
  'alex@dealeraddendums.com',
  'claire@dealeraddendums.com',
  'marlena@dealeraddendums.com',
  'carol@dealeraddendums.com'
]) and role = 'super_admin'
on conflict do nothing;
insert into public.staff_permissions (user_id, permission)
select id, 'crm_admin' from public.profiles
where lower(email) = 'allan@dealeraddendums.com' and role = 'super_admin'
on conflict do nothing;

-- ── Phone normalization (mirror of lib/crm/phone.ts normalizePhone) ──────────
-- NANP-first: 10 digits → +1…, 11 starting with 1 → +…, an explicit leading +
-- (or 011) keeps its country code. Extensions dropped. Anything else → null.
-- Keep the two in step (scripts/crm-verify-unit.ts pins the shared cases).
create or replace function public.crm_normalize_phone(p_raw text)
returns text
language plpgsql
immutable
as $$
declare
  s text;
  d text;
begin
  if p_raw is null then return null; end if;
  s := lower(btrim(p_raw));
  s := regexp_replace(s, '\s*(x|ext\.?|extension)\s*\d+\s*$', '');
  d := regexp_replace(s, '\D', '', 'g');
  if left(s, 1) = '+' or (left(d, 3) = '011' and length(d) between 11 and 18) then
    if left(s, 1) <> '+' then d := substr(d, 4); end if;
    if left(d, 1) = '1' and length(d) <> 11 then return null; end if;
    if length(d) between 8 and 15 and left(d, 1) <> '0' then return '+' || d; end if;
    return null;
  end if;
  if length(d) = 11 and left(d, 1) = '1' then d := substr(d, 2); end if;
  if length(d) = 10 and substr(d, 1, 1) between '2' and '9' and substr(d, 4, 1) between '2' and '9' then
    return '+1' || d;
  end if;
  return null;
end;
$$;

create index if not exists dealers_crm_phone_idx
  on public.dealers (public.crm_normalize_phone(phone))
  where phone is not null;

-- ── Settings (single row) ────────────────────────────────────────────────────
create table if not exists public.crm_settings (
  id             boolean     primary key default true check (id),
  platform_name  text        not null default 'DA-CRM',
  logo_s3_key    text,
  updated_by     uuid        references public.profiles(id) on delete set null,
  updated_at     timestamptz not null default now()
);
insert into public.crm_settings (id) values (true) on conflict do nothing;

-- ── Team ─────────────────────────────────────────────────────────────────────
-- Two teams; Management's specialities are capability tags, not more teams.
create table if not exists public.crm_staff_profiles (
  staff_id              uuid        primary key references public.profiles(id) on delete cascade,
  team                  text        not null default 'customer_support' check (team in ('customer_support','management')),
  capabilities          text[]      not null default '{}'
                                    check (capabilities <@ array['tier1','tier2','feed_support','ar_ap']::text[]),
  full_name             text,
  -- {"mon":{"start":"08:00","end":"17:00"}, …}; a missing day = off.
  work_hours            jsonb       not null default '{}'::jsonb,
  time_zone             text        not null default 'America/Los_Angeles',
  cell_phone            text        check (cell_phone is null or cell_phone ~ '^\+[1-9][0-9]{6,14}$'),
  email_signature_html  text,
  photo_s3_key          text,
  dialpad_user_id       text        unique,
  dialpad_number        text        check (dialpad_number is null or dialpad_number ~ '^\+[1-9][0-9]{6,14}$'),
  active                boolean     not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ── Companies ────────────────────────────────────────────────────────────────
create table if not exists public.crm_companies (
  id                  uuid        primary key default gen_random_uuid(),
  kind                text        not null check (kind in ('dealer','group','vendor','feed_supplier')),
  dealer_id           uuid        unique references public.dealers(id) on delete cascade,
  group_id            uuid        unique references public.groups(id) on delete cascade,
  -- vendor / feed_supplier only; dealer and group names come from the source row.
  name                text,
  emails              jsonb       not null default '[]'::jsonb check (jsonb_typeof(emails) = 'array'),  -- [{address,label}]
  phone               text        check (phone is null or phone ~ '^\+[1-9][0-9]{6,14}$'),
  website             text,
  notes               text,
  pipeline_stage      text        check (pipeline_stage in ('trial','setup_training','paying','cancelled','lost')),
  stage_changed_at    timestamptz,
  trial_started_at    timestamptz,
  -- Maintained by the 06:00 PT trial job (POST /api/cron/crm-trial-day); also
  -- computable any time with public.crm_trial_day(trial_started_at).
  trial_day           integer,
  trial_ends_on       date,
  trial_flag          text        check (trial_flag in ('expiring','expired')),
  owner_staff_id      uuid        references public.profiles(id) on delete set null,
  hubspot_company_id  text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint crm_companies_kind_shape check (
    (kind = 'dealer'        and dealer_id is not null and group_id is null) or
    (kind = 'group'         and group_id  is not null and dealer_id is null) or
    (kind in ('vendor','feed_supplier') and dealer_id is null and group_id is null and name is not null)
  ),
  -- Pipeline + trial are dealer-only.
  constraint crm_companies_dealer_fields check (
    kind = 'dealer' or (pipeline_stage is null and trial_started_at is null and trial_day is null and trial_flag is null)
  )
);
create index if not exists crm_companies_kind_idx  on public.crm_companies (kind);
create index if not exists crm_companies_stage_idx on public.crm_companies (pipeline_stage) where pipeline_stage is not null;
create index if not exists crm_companies_owner_idx on public.crm_companies (owner_staff_id) where owner_staff_id is not null;
create index if not exists crm_companies_phone_idx on public.crm_companies (phone) where phone is not null;

-- Trial day: day 1 = the Pacific calendar day the trial started.
create or replace function public.crm_trial_day(p_started timestamptz, p_now timestamptz default now())
returns integer
language sql
stable
as $$
  select case when p_started is null then null else
    ((p_now at time zone 'America/Los_Angeles')::date - (p_started at time zone 'America/Los_Angeles')::date) + 1
  end;
$$;

-- Backfill: one company per existing dealer and group. Stage starts from the
-- platform's account state (scripts/crm-seed.ts --companies re-derives it with
-- the app's own isPayingAccount / isTrialAccountType rules).
insert into public.crm_companies (kind, dealer_id, phone, pipeline_stage, stage_changed_at, trial_started_at, hubspot_company_id)
select 'dealer', d.id, public.crm_normalize_phone(d.phone),
  case
    when not d.active then 'cancelled'
    when d.account_type is null or d.account_type ilike 'trial%' then 'trial'
    when d.account_type ilike any (array['free%','downgraded%']) or d.downgraded_at is not null then 'cancelled'
    else 'paying'
  end,
  now(),
  case when d.active and (d.account_type is null or d.account_type ilike 'trial%') then d.created_at end,
  nullif(d.hubspot_company_id, '')
from public.dealers d
on conflict (dealer_id) do nothing;

insert into public.crm_companies (kind, group_id, phone, hubspot_company_id)
select 'group', g.id, public.crm_normalize_phone(g.phone), nullif(g.hubspot_company_id, '')
from public.groups g
on conflict (group_id) do nothing;

-- New dealers / groups get their company row automatically (any writer:
-- self-serve, admin UI, ETL, migration flow).
create or replace function public.crm_company_for_new_dealer()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.crm_companies (kind, dealer_id, phone, pipeline_stage, stage_changed_at, trial_started_at, hubspot_company_id)
  values ('dealer', new.id, public.crm_normalize_phone(new.phone),
    case when new.account_type is null or new.account_type ilike 'trial%' then 'trial' else 'paying' end,
    now(),
    case when new.account_type is null or new.account_type ilike 'trial%' then coalesce(new.created_at, now()) end,
    nullif(new.hubspot_company_id, ''))
  on conflict (dealer_id) do nothing;
  return new;
exception when others then
  -- Never block dealer creation over a CRM row; the seed script backfills gaps.
  raise warning 'crm_company_for_new_dealer: %', sqlerrm;
  return new;
end;
$$;
drop trigger if exists dealers_crm_company on public.dealers;
create trigger dealers_crm_company after insert on public.dealers
  for each row execute function public.crm_company_for_new_dealer();

create or replace function public.crm_company_for_new_group()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.crm_companies (kind, group_id, phone, hubspot_company_id)
  values ('group', new.id, public.crm_normalize_phone(new.phone), nullif(new.hubspot_company_id, ''))
  on conflict (group_id) do nothing;
  return new;
exception when others then
  raise warning 'crm_company_for_new_group: %', sqlerrm;
  return new;
end;
$$;
drop trigger if exists groups_crm_company on public.groups;
create trigger groups_crm_company after insert on public.groups
  for each row execute function public.crm_company_for_new_group();

-- Ownership changes need crm_admin when made through a user session. The
-- service role (auth.uid() null) is trusted; the API checks crm_admin itself.
create or replace function public.crm_guard_owner_change()
returns trigger language plpgsql as $$
begin
  if new.owner_staff_id is distinct from old.owner_staff_id
     and auth.uid() is not null
     and not public.has_staff_permission('crm_admin') then
    raise exception 'Changing a company owner requires crm_admin';
  end if;
  if new.pipeline_stage is distinct from old.pipeline_stage then
    new.stage_changed_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists crm_companies_guard on public.crm_companies;
create trigger crm_companies_guard before update on public.crm_companies
  for each row execute function public.crm_guard_owner_change();

-- ── Brands ───────────────────────────────────────────────────────────────────
create table if not exists public.crm_brands (
  brand  text    primary key,
  sort   integer not null default 0
);
insert into public.crm_brands (brand, sort) values
  ('Acura',1),('Alfa Romeo',2),('Aston Martin',3),('Audi',4),('Bentley',5),('BMW',6),('Buick',7),
  ('Cadillac',8),('Chevrolet',9),('Chrysler',10),('Dodge',11),('Ferrari',12),('FIAT',13),('Ford',14),
  ('Genesis',15),('GMC',16),('Honda',17),('Hyundai',18),('INFINITI',19),('Jaguar',20),('Jeep',21),
  ('Kia',22),('Lamborghini',23),('Land Rover',24),('Lexus',25),('Lincoln',26),('Lotus',27),('Lucid',28),
  ('Maserati',29),('Mazda',30),('McLaren',31),('Mercedes-Benz',32),('MINI',33),('Mitsubishi',34),
  ('Nissan',35),('Polestar',36),('Porsche',37),('RAM',38),('Rivian',39),('Rolls-Royce',40),('Subaru',41),
  ('Tesla',42),('Toyota',43),('Volkswagen',44),('Volvo',45),('Harley-Davidson',46),('Indian',47),
  ('Kawasaki',48),('Yamaha',49),('Polaris',50),('Can-Am',51),('Airstream',52),('Winnebago',53)
on conflict (brand) do nothing;

create table if not exists public.crm_company_brands (
  company_id  uuid not null references public.crm_companies(id) on delete cascade,
  brand       text not null references public.crm_brands(brand) on update cascade,
  primary key (company_id, brand)
);

-- ── Files ────────────────────────────────────────────────────────────────────
create table if not exists public.crm_company_files (
  id            uuid        primary key default gen_random_uuid(),
  company_id    uuid        not null references public.crm_companies(id) on delete cascade,
  filename      text        not null,
  content_type  text,
  size          bigint,
  s3_key        text        not null unique,   -- crm/{company_id}/files/{id}/{filename}
  label         text,
  uploaded_by   uuid        references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index if not exists crm_company_files_company_idx on public.crm_company_files (company_id, created_at desc) where deleted_at is null;

-- ── Contacts ─────────────────────────────────────────────────────────────────
create table if not exists public.crm_contacts (
  id                  uuid        primary key default gen_random_uuid(),
  company_id          uuid        not null references public.crm_companies(id) on delete cascade,
  user_id             uuid        references public.profiles(id) on delete set null,
  first_name          text,
  last_name           text,
  email               text,
  phone               text        check (phone is null or phone ~ '^\+[1-9][0-9]{6,14}$'),
  title               text,
  role_tag            text        check (role_tag is null or role_tag in ('decision_maker','fi','gm','admin','other')),
  hubspot_contact_id  text,
  source              text        not null default 'manual',  -- manual | seed | dialpad | hubspot_import
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);
-- One live contact per email per company (case-insensitive).
create unique index if not exists crm_contacts_company_email_uniq
  on public.crm_contacts (company_id, lower(email))
  where email is not null and deleted_at is null;
create index if not exists crm_contacts_phone_idx   on public.crm_contacts (phone) where phone is not null and deleted_at is null;
create index if not exists crm_contacts_company_idx on public.crm_contacts (company_id) where deleted_at is null;
create index if not exists crm_contacts_user_idx    on public.crm_contacts (user_id) where user_id is not null;
create index if not exists crm_contacts_hubspot_idx on public.crm_contacts (hubspot_contact_id) where hubspot_contact_id is not null;

-- ── Activities (the single timeline) ─────────────────────────────────────────
create table if not exists public.crm_activities (
  id              uuid        primary key default gen_random_uuid(),
  company_id      uuid        references public.crm_companies(id) on delete set null,   -- null = Unmatched
  contact_id      uuid        references public.crm_contacts(id) on delete set null,
  type            text        not null constraint crm_activities_type_check
                              check (type in ('call','email','chat','note','status_change','task','ticket','file')),
  direction       text        not null check (direction in ('inbound','outbound','internal')),
  subject         text,
  body            text,
  metadata        jsonb       not null default '{}'::jsonb,
  -- Source-system id, namespaced ('dialpad:…', 'billing:…', 'trial:…').
  -- Non-partial unique so writers can upsert; NULLs never collide.
  external_id     text,
  occurred_at     timestamptz not null default now(),
  actor_staff_id  uuid        references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index if not exists crm_activities_company_time_idx on public.crm_activities (company_id, occurred_at desc);
create index if not exists crm_activities_contact_time_idx on public.crm_activities (contact_id, occurred_at desc);
create index if not exists crm_activities_unmatched_idx    on public.crm_activities (occurred_at desc) where company_id is null;
create unique index if not exists crm_activities_external_uniq on public.crm_activities (type, external_id);

-- ── Calls ────────────────────────────────────────────────────────────────────
create table if not exists public.crm_calls (
  id                uuid        primary key default gen_random_uuid(),
  activity_id       uuid        not null unique references public.crm_activities(id) on delete cascade,
  dialpad_call_id   text        not null unique,   -- int64 kept as text so nothing rounds it
  company_id        uuid        references public.crm_companies(id) on delete set null,   -- null = Unmatched
  contact_id        uuid        references public.crm_contacts(id) on delete set null,
  staff_id          uuid        references public.profiles(id) on delete set null,
  dialpad_user_id   text,
  direction         text        not null check (direction in ('inbound','outbound')),
  from_number       text,
  to_number         text,
  started_at        timestamptz,
  answered_at       timestamptz,
  ended_at          timestamptz,
  duration_sec      integer,
  state             text        not null default 'ringing'
                                check (state in ('ringing','connected','voicemail','missed','completed')),
  recording_url     text,       -- Dialpad's URL (may need auth / expire)
  recording_s3_key  text,       -- our copy: crm/{company_id|unmatched}/calls/{id}.mp3
  voicemail_url     text,
  transcript        text,
  summary           text,       -- Dialpad AI recap
  sentiment         text,
  last_event_at     timestamptz,
  raw               jsonb       not null default '{}'::jsonb,  -- latest payload per Dialpad state
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists crm_calls_started_idx   on public.crm_calls (started_at desc);
create index if not exists crm_calls_company_idx   on public.crm_calls (company_id, started_at desc);
create index if not exists crm_calls_contact_idx   on public.crm_calls (contact_id, started_at desc);
create index if not exists crm_calls_staff_idx     on public.crm_calls (staff_id, started_at desc);
create index if not exists crm_calls_unmatched_idx on public.crm_calls (started_at desc) where company_id is null;

-- ── Tickets / tasks (stubs — UI in phases 4 and 5) ───────────────────────────
-- Tickets = things that need fixing; tasks = things to do. Either can be
-- opened from any activity (call, email, chat) or from a company / contact
-- record — source_activity_id points at the activity it came from (for a
-- record-level open, the 'ticket'/'task' activity written at creation).
create table if not exists public.crm_tickets (
  id                  uuid        primary key default gen_random_uuid(),
  company_id          uuid        references public.crm_companies(id) on delete set null,
  contact_id          uuid        references public.crm_contacts(id) on delete set null,
  title               text        not null,
  status              text        not null default 'open' check (status in ('open','pending','resolved','closed')),
  assigned_staff_id   uuid        references public.profiles(id) on delete set null,
  source_activity_id  uuid        references public.crm_activities(id) on delete set null,
  created_at          timestamptz not null default now()
);
create index if not exists crm_tickets_company_open_idx on public.crm_tickets (company_id) where status in ('open','pending');
create table if not exists public.crm_tasks (
  id                  uuid        primary key default gen_random_uuid(),
  company_id          uuid        references public.crm_companies(id) on delete set null,
  contact_id          uuid        references public.crm_contacts(id) on delete set null,
  title               text        not null,
  status              text        not null default 'open' check (status in ('open','done','cancelled')),
  assigned_staff_id   uuid        references public.profiles(id) on delete set null,
  source_activity_id  uuid        references public.crm_activities(id) on delete set null,
  created_at          timestamptz not null default now()
);
create index if not exists crm_tasks_company_open_idx  on public.crm_tasks (company_id) where status = 'open';
create index if not exists crm_tasks_assignee_open_idx on public.crm_tasks (assigned_staff_id) where status = 'open';

-- ── Raw Dialpad webhook log ──────────────────────────────────────────────────
create table if not exists public.crm_dialpad_events (
  id               uuid        primary key default gen_random_uuid(),
  received_at      timestamptz not null default now(),
  source           text        not null default 'webhook' check (source in ('webhook','reconcile','replay')),
  dialpad_call_id  text,
  state            text,
  event_timestamp  bigint,
  payload          jsonb       not null,
  processed_at     timestamptz,
  error            text
);
-- Exact redeliveries (same call, state, event time) are logged once.
create unique index if not exists crm_dialpad_events_dedupe
  on public.crm_dialpad_events (dialpad_call_id, state, event_timestamp);
create index if not exists crm_dialpad_events_received_idx on public.crm_dialpad_events (received_at desc);

-- ── Outbound webhooks (da-billing and future subscribers) ────────────────────
create table if not exists public.crm_webhook_subscriptions (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  url         text        not null check (url ~ '^https://'),
  -- company.stage_changed | company.owner_changed | contact.created | contact.updated
  events      text[]      not null,
  active      boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create table if not exists public.crm_webhook_deliveries (
  id                uuid        primary key default gen_random_uuid(),
  subscription_id   uuid        not null references public.crm_webhook_subscriptions(id) on delete cascade,
  event             text        not null,
  event_id          text        not null,          -- same id on every retry (receiver dedupe)
  payload           jsonb       not null,
  status            text        not null default 'pending' check (status in ('pending','delivered','failed')),
  attempts          integer     not null default 0,
  next_attempt_at   timestamptz not null default now(),
  last_status_code  integer,
  last_error        text,
  delivered_at      timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists crm_webhook_deliveries_due_idx on public.crm_webhook_deliveries (next_attempt_at) where status = 'pending';

-- ── updated_at triggers ──────────────────────────────────────────────────────
create or replace function public.crm_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;
do $$
declare t text;
begin
  foreach t in array array['crm_companies','crm_contacts','crm_calls','crm_staff_profiles','crm_settings','crm_webhook_subscriptions'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.crm_touch_updated_at()', t || '_touch', t);
  end loop;
end $$;

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- API routes use the service role after requireCrmStaff(); these policies are
-- the backstop for any user-scoped client. 'crm' = read/write the CRM;
-- 'crm_admin' = team, settings, webhook subscriptions (and owner changes,
-- enforced by crm_guard_owner_change).
do $$
declare t text;
begin
  foreach t in array array['crm_companies','crm_company_brands','crm_company_files','crm_contacts','crm_activities',
                           'crm_calls','crm_tickets','crm_tasks'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_staff', t);
    execute format('create policy %I on public.%I for all using (public.has_staff_permission(''crm'')) with check (public.has_staff_permission(''crm''))', t || '_staff', t);
  end loop;
  foreach t in array array['crm_staff_profiles','crm_settings','crm_brands'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select using (public.has_staff_permission(''crm''))', t || '_read', t);
    execute format('drop policy if exists %I on public.%I', t || '_admin', t);
    execute format('create policy %I on public.%I for all using (public.has_staff_permission(''crm_admin'')) with check (public.has_staff_permission(''crm_admin''))', t || '_admin', t);
  end loop;
  foreach t in array array['crm_dialpad_events','crm_webhook_subscriptions','crm_webhook_deliveries'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_admin', t);
    execute format('create policy %I on public.%I for select using (public.has_staff_permission(''crm_admin''))', t || '_admin', t);
  end loop;
end $$;
-- A team member may edit their own profile (hours, signature, photo) — but
-- not their team / capabilities; the API restricts those fields to crm_admin.
drop policy if exists crm_staff_profiles_self on public.crm_staff_profiles;
create policy crm_staff_profiles_self on public.crm_staff_profiles
  for update using (staff_id = auth.uid() and public.has_staff_permission('crm'))
  with check (staff_id = auth.uid());

-- ── Matching: companies by normalized phone ──────────────────────────────────
-- The company's own phone first; for dealer rows without one, the dealer's
-- main phone from the platform record.
create or replace function public.crm_companies_by_phone(p_e164 text)
returns table (id uuid, kind text, active boolean)
language sql stable
as $$
  select c.id, c.kind, coalesce(d.active, true)
  from public.crm_companies c
  left join public.dealers d on d.id = c.dealer_id
  where c.phone = p_e164
  union
  select c.id, c.kind, d.active
  from public.dealers d
  join public.crm_companies c on c.dealer_id = d.id
  where c.phone is null and d.phone is not null and public.crm_normalize_phone(d.phone) = p_e164;
$$;

-- ── Directory view: one row per company with names resolved from source ─────
create or replace view public.crm_company_directory
with (security_invoker = true) as
select
  c.id, c.kind, c.dealer_id, c.group_id,
  coalesce(d.name, g.name, c.name)            as name,
  d.dealer_id                                 as dealer_text_id,
  coalesce(d.active, g.active, true)          as active,
  coalesce(d.city, g.city)                    as city,
  coalesce(d.state, g.state)                  as state,
  coalesce(c.phone, public.crm_normalize_phone(coalesce(d.phone, g.phone))) as phone,
  d.account_type,
  d.group_id                                  as parent_group_id,
  c.pipeline_stage, c.stage_changed_at, c.trial_started_at, c.trial_day, c.trial_ends_on, c.trial_flag,
  c.owner_staff_id,
  coalesce(c.hubspot_company_id, nullif(d.hubspot_company_id, ''), nullif(g.hubspot_company_id, '')) as hubspot_company_id,
  a.last_activity_at,
  a.last_contact_at,
  coalesce(ct.contact_count, 0) as contact_count,
  coalesce(tk.open_tickets, 0)  as open_tickets,
  coalesce(ts.open_tasks, 0)    as open_tasks
from public.crm_companies c
left join public.dealers d on d.id = c.dealer_id
left join public.groups  g on g.id = c.group_id
left join (
  select company_id,
         max(occurred_at) as last_activity_at,
         max(occurred_at) filter (where type in ('call','email','chat') and direction <> 'internal') as last_contact_at
  from public.crm_activities where company_id is not null group by company_id
) a on a.company_id = c.id
left join (select company_id, count(*) as contact_count from public.crm_contacts where deleted_at is null group by company_id) ct on ct.company_id = c.id
left join (select company_id, count(*) as open_tickets from public.crm_tickets where status in ('open','pending') group by company_id) tk on tk.company_id = c.id
left join (select company_id, count(*) as open_tasks from public.crm_tasks where status = 'open' group by company_id) ts on ts.company_id = c.id;

-- ── HubSpot id resolution (for the later HubSpot import) ─────────────────────
create or replace view public.crm_hubspot_company_map
with (security_invoker = true) as
select coalesce(c.hubspot_company_id, nullif(d.hubspot_company_id, ''), nullif(g.hubspot_company_id, '')) as hubspot_company_id,
       c.id as company_id, c.kind
from public.crm_companies c
left join public.dealers d on d.id = c.dealer_id
left join public.groups  g on g.id = c.group_id
where coalesce(c.hubspot_company_id, nullif(d.hubspot_company_id, ''), nullif(g.hubspot_company_id, '')) is not null;

-- hubspot_contact_id → crm_contacts, directly or through the platform user the
-- contact represents (profiles.hubspot_contact_id, set by the Phase 14 sync).
create or replace view public.crm_hubspot_contact_map
with (security_invoker = true) as
select c.hubspot_contact_id, c.id as contact_id, c.company_id, 'contact'::text as matched_via
from public.crm_contacts c
where c.hubspot_contact_id is not null and c.deleted_at is null
union all
select p.hubspot_contact_id, c.id, c.company_id, 'profile'::text
from public.profiles p
join public.crm_contacts c on c.user_id = p.id and c.deleted_at is null
where p.hubspot_contact_id is not null
  and (c.hubspot_contact_id is null or c.hubspot_contact_id <> p.hubspot_contact_id);

create or replace function public.crm_resolve_hubspot_contact(p_hubspot_contact_id text)
returns uuid
language sql stable
as $$
  select contact_id from public.crm_hubspot_contact_map
  where hubspot_contact_id = p_hubspot_contact_id
  order by (matched_via = 'contact') desc
  limit 1;
$$;

create or replace function public.crm_resolve_hubspot_company(p_hubspot_company_id text)
returns uuid
language sql stable
as $$
  select company_id from public.crm_hubspot_company_map
  where hubspot_company_id = p_hubspot_company_id
  order by (kind = 'dealer') desc
  limit 1;
$$;
