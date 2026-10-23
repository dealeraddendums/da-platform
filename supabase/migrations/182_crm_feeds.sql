-- 182_crm_feeds.sql — DA-CRM Phase 2b: Data Feeds order flow.
--
-- Upgrading a dealer from Manual / Free to an Automatic inventory feed:
--   1. ask the dealer's approver to Reply All "APPROVED", with the feed supplier on Cc
--      (or a signed PDF, or the supplier's own portal)
--   2. the supplier emails back the Feed ID
--   3. staff confirm it, and DA-CRM writes dealers.inventory_provider and
--      inventory_dealer_id through the platform's own Feed ID service
--      (lib/dealer-feed-id.ts)
-- All feed mail goes out from, and comes back to, feeds@ (Phase 2 Inbox).
-- Order status changes ONLY through advanceOrder() (lib/crm/feeds/state.ts).
-- Every change is a crm_feed_order_events row AND a crm_activities row
-- ('feed_order') on the dealer's timeline.
-- Depends on 179 (companies, contacts, activities, tasks, has_staff_permission),
-- 180 (templates) and 181 (crm_email_threads, crm_emails).

-- ── Feed supplier configuration (crm_companies kind = feed_supplier) ────────
create table if not exists public.crm_feed_supplier_settings (
  company_id              uuid        primary key references public.crm_companies(id) on delete cascade,
  request_method          text        not null default 'email' check (request_method in ('email','pdf','api')),
  request_email           text        check (request_email is null or request_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  cc_emails               jsonb       not null default '[]'::jsonb check (jsonb_typeof(cc_emails) = 'array'),   -- ["a@x.com", …]
  pdf_template_s3_key     text,
  pdf_field_map           jsonb       not null default '{}'::jsonb check (jsonb_typeof(pdf_field_map) = 'object'),  -- {"PdfField": "{{company.name}}"}
  feed_id_pattern         text,       -- regex for the Feed ID in supplier replies (null = the generic rules)
  typical_turnaround_days integer     not null default 2 check (typical_turnaround_days between 0 and 60),
  -- The name written to dealers.inventory_provider (lib/inventory-providers.ts) and its DMS flag.
  platform_provider       text,
  is_dms                  boolean     not null default false,
  needs_review            boolean     not null default true,   -- request address / method not confirmed yet
  notes                   text,
  updated_by              uuid        references public.profiles(id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- ── Orders ───────────────────────────────────────────────────────────────────
create table if not exists public.crm_feed_orders (
  id                      uuid        primary key default gen_random_uuid(),
  dealer_company_id       uuid        not null references public.crm_companies(id) on delete cascade,
  supplier_company_id     uuid        references public.crm_companies(id) on delete set null,
  source                  text        not null check (source in ('call','chat','email','self_serve')),
  initiated_by_staff_id   uuid        references public.profiles(id) on delete set null,
  owner_staff_id          uuid        references public.profiles(id) on delete set null,
  approver_name           text,
  approver_email          text        check (approver_email is null or approver_email = lower(approver_email)),
  approver_phone          text,
  status                  text        not null default 'needs_info' check (status in (
                            'needs_info','ready','request_sent','awaiting_dealer_approval','awaiting_supplier',
                            'feed_id_received','assigned','done','cancelled')),
  cancel_reason           text,
  email_thread_id         uuid        references public.crm_email_threads(id) on delete set null,
  pdf_s3_key              text,
  signed_pdf_s3_key       text,
  feed_id_candidate       text,
  feed_id_confirmed       text,
  confirmed_by_staff_id   uuid        references public.profiles(id) on delete set null,
  notes                   text,
  sent_at                 timestamptz,
  dealer_approved_at      timestamptz,
  supplier_replied_at     timestamptz,
  assigned_at             timestamptz,
  stall_timer_started_at  timestamptz not null default now(),
  stalled_nudges          integer     not null default 0,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint crm_feed_orders_cancel_reason check (status <> 'cancelled' or coalesce(cancel_reason, '') <> '')
);
-- One open order per dealer: a second "Start feed order" (or the self-serve
-- hook racing a staff member) finds the open one instead of duplicating it.
create unique index if not exists crm_feed_orders_one_open
  on public.crm_feed_orders (dealer_company_id) where status not in ('done','cancelled');
create index if not exists crm_feed_orders_status_idx   on public.crm_feed_orders (status, stall_timer_started_at);
create index if not exists crm_feed_orders_owner_idx    on public.crm_feed_orders (owner_staff_id, status);
create index if not exists crm_feed_orders_supplier_idx on public.crm_feed_orders (supplier_company_id, status);
create index if not exists crm_feed_orders_thread_idx   on public.crm_feed_orders (email_thread_id);

create table if not exists public.crm_feed_order_events (
  id           uuid        primary key default gen_random_uuid(),
  order_id     uuid        not null references public.crm_feed_orders(id) on delete cascade,
  type         text        not null,
  detail       jsonb       not null default '{}'::jsonb,
  actor        text        not null,          -- staff uuid, or 'system'
  occurred_at  timestamptz not null default now()
);
create index if not exists crm_feed_order_events_order_idx on public.crm_feed_order_events (order_id, occurred_at);

-- feeds@ mail no order could be found for (Feeds queue → Unmatched).
create table if not exists public.crm_feed_unmatched (
  id                 uuid        primary key default gen_random_uuid(),
  email_id           uuid        not null unique references public.crm_emails(id) on delete cascade,
  thread_id          uuid        not null references public.crm_email_threads(id) on delete cascade,
  reason             text        not null,
  resolved_at        timestamptz,
  resolved_order_id  uuid        references public.crm_feed_orders(id) on delete set null,
  resolved_by        uuid        references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now()
);
create index if not exists crm_feed_unmatched_open_idx on public.crm_feed_unmatched (created_at desc) where resolved_at is null;

-- ── Tasks (stub table from 179): what feed orders need ──────────────────────
alter table public.crm_tasks
  add column if not exists description          text,
  add column if not exists due_at               timestamptz,
  add column if not exists kind                 text,      -- e.g. feed_get_info, feed_confirm_id, feed_call_approver
  add column if not exists feed_order_id        uuid references public.crm_feed_orders(id) on delete cascade,
  add column if not exists assigned_capability  text check (assigned_capability is null or assigned_capability in ('tier1','tier2','feed_support','ar_ap')),
  add column if not exists completed_at         timestamptz,
  add column if not exists created_by           uuid references public.profiles(id) on delete set null;
create index if not exists crm_tasks_feed_order_idx on public.crm_tasks (feed_order_id) where status = 'open';

-- ── Timeline: feed order events ─────────────────────────────────────────────
alter table public.crm_activities drop constraint if exists crm_activities_type_check;
alter table public.crm_activities add constraint crm_activities_type_check
  check (type in ('call','email','chat','note','status_change','task','ticket','file','feed_order'));

-- ── Templates: "Feed requests" kinds, per-supplier folders ───────────────────
-- A template with feed_kind set is a feed template. supplier_company_id null =
-- the global default for that kind; a supplier's folder overrides only the
-- kinds it needs (resolution: supplier override → global default).
alter table public.crm_email_templates
  add column if not exists feed_kind text check (feed_kind is null or feed_kind in
    ('request','request_pdf','dealer_followup','supplier_followup','feed_assigned')),
  add column if not exists supplier_company_id uuid references public.crm_companies(id) on delete cascade;
create unique index if not exists crm_email_templates_feed_kind_uniq
  on public.crm_email_templates (feed_kind, coalesce(supplier_company_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where feed_kind is not null and not archived;

-- ── Settings ─────────────────────────────────────────────────────────────────
-- Approval phrases (case-insensitive, whole words) in the dealer's newest reply text.
alter table public.crm_settings
  add column if not exists feed_approval_phrases jsonb not null default
    '["APPROVED","approve","approved","ok to send","yes approved","go ahead"]'::jsonb;
-- Per-staff: send feed requests without the review slide-over.
alter table public.crm_staff_profiles
  add column if not exists feed_send_without_review boolean not null default false;

-- ── Triggers / RLS ───────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['crm_feed_supplier_settings','crm_feed_orders'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.crm_touch_updated_at()', t || '_touch', t);
  end loop;
  foreach t in array array['crm_feed_orders','crm_feed_order_events','crm_feed_unmatched'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_staff', t);
    execute format('create policy %I on public.%I for all using (public.has_staff_permission(''crm'')) with check (public.has_staff_permission(''crm''))', t || '_staff', t);
  end loop;
  -- Supplier settings: everyone reads, crm_admin edits.
  execute 'alter table public.crm_feed_supplier_settings enable row level security';
  execute 'drop policy if exists crm_feed_supplier_settings_read on public.crm_feed_supplier_settings';
  execute 'create policy crm_feed_supplier_settings_read on public.crm_feed_supplier_settings for select using (public.has_staff_permission(''crm''))';
  execute 'drop policy if exists crm_feed_supplier_settings_admin on public.crm_feed_supplier_settings';
  execute 'create policy crm_feed_supplier_settings_admin on public.crm_feed_supplier_settings for all using (public.has_staff_permission(''crm_admin'')) with check (public.has_staff_permission(''crm_admin''))';
end $$;
