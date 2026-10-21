-- 181_crm_inbox.sql — DA-CRM Phase 2: Inbox (Microsoft Graph, multi-mailbox).
--
-- Shared Office 365 mailboxes (support@, feeds@) synced into one Inbox,
-- threaded per mailbox on Graph's conversationId and matched to companies /
-- contacts. Outlook stays the system of record: DA-CRM replies through Graph
-- as the thread's mailbox, so Outlook keeps the conversation intact.
-- Message ids are Graph IMMUTABLE ids (Prefer: IdType="ImmutableId"), so a
-- message keeps its id when it moves Drafts → Sent Items; that is what lets a
-- message sent from DA-CRM dedupe against the Sent Items sync.
-- Every stored email also writes a crm_activities row (type 'email') so it
-- shows on the Phase 1 timeline. See lib/crm/inbox-*.ts and CLAUDE.md.
-- Depends on 179 (crm_companies, crm_contacts, crm_activities,
-- has_staff_permission, crm_touch_updated_at).

-- ── Mailboxes ────────────────────────────────────────────────────────────────
-- One Graph change-notification subscription per synced folder (Inbox, Sent
-- Items), each with its own delta link for the 10-minute fallback sync.
create table if not exists public.crm_mailboxes (
  id                             uuid        primary key default gen_random_uuid(),
  address                        text        not null check (address = lower(address) and address ~ '^[^@\s]+@[^@\s]+$'),
  display_name                   text        not null,
  purpose                        text        not null check (purpose in ('support','feeds')),
  active                         boolean     not null default true,
  graph_subscription_id          text,         -- Inbox subscription
  subscription_expires_at        timestamptz,
  graph_subscription_id_sent     text,         -- Sent Items subscription
  subscription_sent_expires_at   timestamptz,
  delta_token_inbox              text,         -- full @odata.deltaLink
  delta_token_sent               text,
  last_synced_at                 timestamptz,
  last_error                     text,
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now()
);
create unique index if not exists crm_mailboxes_address_uniq on public.crm_mailboxes (address);

insert into public.crm_mailboxes (address, display_name, purpose) values
  ('support@dealeraddendums.com', 'DealerAddendums Support', 'support'),
  ('feeds@dealeraddendums.com',   'DealerAddendums Feeds',   'feeds')
on conflict (address) do nothing;

-- ── Threads ──────────────────────────────────────────────────────────────────
create table if not exists public.crm_email_threads (
  id                     uuid        primary key default gen_random_uuid(),
  mailbox_id             uuid        not null references public.crm_mailboxes(id) on delete cascade,
  graph_conversation_id  text        not null,
  company_id             uuid        references public.crm_companies(id) on delete set null,   -- null = Unassigned
  contact_id             uuid        references public.crm_contacts(id) on delete set null,
  subject                text,
  status                 text        not null default 'open' check (status in ('open','waiting_on_dealer','closed')),
  assigned_staff_id      uuid        references public.profiles(id) on delete set null,
  last_message_at        timestamptz,
  last_direction         text        check (last_direction in ('inbound','outbound')),
  unread                 boolean     not null default true,
  -- Only DealerAddendums addresses on it (staff ↔ mailbox) — never "Unassigned".
  internal               boolean     not null default false,
  -- How the company was found: contact | company_email | domain | manual (null = not matched).
  matched_by             text,
  -- Possible companies when the match was ambiguous (shown in the Unassigned view).
  match_candidates       uuid[]      not null default '{}',
  message_count          integer     not null default 0,
  -- Latest message, denormalized for the thread list.
  last_from_email        text,
  last_from_name         text,
  last_snippet           text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (mailbox_id, graph_conversation_id)
);
create index if not exists crm_email_threads_list_idx     on public.crm_email_threads (mailbox_id, last_message_at desc);
create index if not exists crm_email_threads_recent_idx   on public.crm_email_threads (last_message_at desc);
create index if not exists crm_email_threads_company_idx  on public.crm_email_threads (company_id, last_message_at desc);
create index if not exists crm_email_threads_contact_idx  on public.crm_email_threads (contact_id, last_message_at desc);
create index if not exists crm_email_threads_assigned_idx on public.crm_email_threads (assigned_staff_id, status);
create index if not exists crm_email_threads_unassigned_idx on public.crm_email_threads (last_message_at desc)
  where company_id is null and not internal;
create index if not exists crm_email_threads_unread_idx on public.crm_email_threads (unread)
  where unread and not internal and status <> 'closed';

-- ── Messages ─────────────────────────────────────────────────────────────────
create table if not exists public.crm_emails (
  id                   uuid        primary key default gen_random_uuid(),
  thread_id            uuid        not null references public.crm_email_threads(id) on delete cascade,
  mailbox_id           uuid        not null references public.crm_mailboxes(id) on delete cascade,
  graph_message_id     text        not null unique,          -- immutable id
  internet_message_id  text,                                 -- RFC 5322 Message-ID
  in_reply_to          text,
  activity_id          uuid        references public.crm_activities(id) on delete set null,
  direction            text        not null check (direction in ('inbound','outbound')),
  from_email           text,
  from_name            text,
  "to"                 jsonb       not null default '[]'::jsonb,   -- [{email,name}]
  cc                   jsonb       not null default '[]'::jsonb,
  bcc                  jsonb       not null default '[]'::jsonb,
  subject              text,
  body_html            text,      -- as received; sanitized at display time
  body_text            text,
  received_at          timestamptz not null,
  sent_by_staff_id     uuid        references public.profiles(id) on delete set null,   -- sent from DA-CRM
  is_reply_all         boolean     not null default false,
  has_attachments      boolean     not null default false,
  raw                  jsonb,      -- Graph message minus the body
  created_at           timestamptz not null default now()
);
-- Second dedupe key: the same Message-ID never lands twice in one mailbox.
-- Non-partial (NULLs never collide) so writers can rely on it.
create unique index if not exists crm_emails_mailbox_imid_uniq on public.crm_emails (mailbox_id, internet_message_id);
create index if not exists crm_emails_thread_time_idx on public.crm_emails (thread_id, received_at);

-- Every participant (from / to / cc / bcc) of every message, normalized — the
-- company / contact Email tabs and later modules (feeds, tickets) query this.
create table if not exists public.crm_email_participants (
  email_id   uuid  not null references public.crm_emails(id) on delete cascade,
  thread_id  uuid  not null references public.crm_email_threads(id) on delete cascade,
  address    text  not null check (address = lower(address)),
  name       text,
  role       text  not null check (role in ('from','to','cc','bcc')),
  primary key (email_id, address, role)
);
create index if not exists crm_email_participants_address_idx on public.crm_email_participants (address, thread_id);
create index if not exists crm_email_participants_thread_idx  on public.crm_email_participants (thread_id);

-- ── Attachments ──────────────────────────────────────────────────────────────
-- Bytes in S3 dealer-addendums at crm/{company_id | unmatched}/email/{crm_emails.id}/{filename}.
-- The bucket is public-read, so the key carries the email row's random UUID;
-- staff download through a short-lived signed URL. s3_key null = not copied
-- (too large, or an attached Outlook item) — open it in Outlook.
create table if not exists public.crm_email_attachments (
  id                   uuid        primary key default gen_random_uuid(),
  email_id             uuid        not null references public.crm_emails(id) on delete cascade,
  graph_attachment_id  text,
  filename             text        not null,
  content_type         text,
  size                 bigint,
  is_inline            boolean     not null default false,
  content_id           text,       -- cid: reference for inline images
  s3_key               text,
  created_at           timestamptz not null default now()
);
create index if not exists crm_email_attachments_email_idx on public.crm_email_attachments (email_id);

-- ── Settings: ignore list + internal domains ────────────────────────────────
-- Sender patterns the sync skips entirely (case-insensitive substrings of the
-- From address; '@domain' entries match the domain). Calendar invites are
-- always skipped. Editable by crm_admin (CLAUDE.md: "Inbox ignore list").
alter table public.crm_settings
  add column if not exists email_ignore_senders jsonb not null default
    '["noreply@","no-reply@","donotreply@","do-not-reply@","mailer-daemon@","postmaster@","bounce","@mandrillapp.com","@mandrill.","@mail.mandrillapp.com","notifications@","calendar-notification@"]'::jsonb,
  add column if not exists email_internal_domains jsonb not null default '["dealeraddendums.com"]'::jsonb;

-- Staff "send without review"-style preferences land in later phases; the
-- Inbox's compose default mailbox lives here so admins can change it.
alter table public.crm_settings
  add column if not exists default_compose_mailbox text not null default 'support@dealeraddendums.com';

-- ── Domain → company lookup ──────────────────────────────────────────────────
-- Host of a URL or email domain, lower-cased, without "www.".
create or replace function public.crm_host(p text)
returns text language sql immutable as $$
  select nullif(regexp_replace(lower(regexp_replace(regexp_replace(regexp_replace(coalesce(p, ''),
    '^\s*[a-z][a-z0-9+.-]*://', '', 'i'), '^[^@/]*@', ''), '[/:?#].*$', '')), '^www\.', ''), '')
$$;

-- Companies whose website (CRM record or the dealer's platform website_url) or
-- the dealer's primary contact email sits on this domain. The caller removes
-- free-mail domains (gmail.com, …) first — see lib/crm/inbox-match.ts.
create or replace function public.crm_companies_by_email_domain(p_domain text)
returns table (id uuid, kind text, active boolean)
language sql stable
as $$
  select c.id, c.kind, coalesce(d.active, g.active, true)
  from public.crm_companies c
  left join public.dealers d on d.id = c.dealer_id
  left join public.groups  g on g.id = c.group_id
  where public.crm_host(c.website) = lower(p_domain)
     or public.crm_host(d.website_url) = lower(p_domain)
     or public.crm_host(d.primary_contact_email) = lower(p_domain)
     or public.crm_host(g.primary_contact_email) = lower(p_domain);
$$;

-- Companies listing this exact address in crm_companies.emails.
create or replace function public.crm_companies_by_email(p_email text)
returns table (id uuid, kind text, active boolean)
language sql stable
as $$
  select c.id, c.kind, coalesce(d.active, g.active, true)
  from public.crm_companies c
  left join public.dealers d on d.id = c.dealer_id
  left join public.groups  g on g.id = c.group_id
  where exists (select 1 from jsonb_array_elements(c.emails) e where lower(e->>'address') = lower(p_email));
$$;

-- Unread, still-open, external threads (sidebar badge).
create or replace function public.crm_inbox_unread_count()
returns integer language sql stable as $$
  select count(*)::int from public.crm_email_threads where unread and not internal and status <> 'closed';
$$;

-- ── Triggers / RLS ───────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['crm_mailboxes','crm_email_threads'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.crm_touch_updated_at()', t || '_touch', t);
  end loop;
  foreach t in array array['crm_email_threads','crm_emails','crm_email_participants','crm_email_attachments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_staff', t);
    execute format('create policy %I on public.%I for all using (public.has_staff_permission(''crm'')) with check (public.has_staff_permission(''crm''))', t || '_staff', t);
  end loop;
  -- Mailboxes carry delta links / subscription ids: everyone reads, crm_admin writes.
  execute 'alter table public.crm_mailboxes enable row level security';
  execute 'drop policy if exists crm_mailboxes_read on public.crm_mailboxes';
  execute 'create policy crm_mailboxes_read on public.crm_mailboxes for select using (public.has_staff_permission(''crm''))';
  execute 'drop policy if exists crm_mailboxes_admin on public.crm_mailboxes';
  execute 'create policy crm_mailboxes_admin on public.crm_mailboxes for all using (public.has_staff_permission(''crm_admin'')) with check (public.has_staff_permission(''crm_admin''))';
end $$;
