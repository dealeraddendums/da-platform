-- 197_crm_email_thread_contacts.sql — an email thread belongs to every contact it was sent to.
--
-- A thread keeps ONE primary company / contact (crm_email_threads.company_id / contact_id — the Inbox
-- match, or the record it was composed from). Compose also links it to every recipient that is a CRM
-- contact (lib/crm/thread-links.ts), at any company, so the thread and its messages show on each of
-- those contacts' and companies' timelines and Email tabs. The company is read through the contact (no
-- copy), so a contact moving companies takes its threads along.

create table if not exists public.crm_email_thread_contacts (
  thread_id  uuid        not null references public.crm_email_threads(id) on delete cascade,
  contact_id uuid        not null references public.crm_contacts(id) on delete cascade,
  source     text        not null default 'compose' check (source in ('compose', 'manual')),
  created_by uuid,
  created_at timestamptz not null default now(),
  primary key (thread_id, contact_id)
);
create index if not exists crm_email_thread_contacts_contact_idx on public.crm_email_thread_contacts (contact_id);

alter table public.crm_email_thread_contacts enable row level security;
drop policy if exists crm_email_thread_contacts_staff on public.crm_email_thread_contacts;
create policy crm_email_thread_contacts_staff on public.crm_email_thread_contacts for all
  using (public.has_staff_permission('crm')) with check (public.has_staff_permission('crm'));
revoke all on public.crm_email_thread_contacts from anon;

-- Thread ids linked to a company (through its contacts) or to one contact. Exactly one argument.
create or replace function public.crm_linked_thread_ids(p_company uuid, p_contact uuid)
returns setof uuid language sql stable security definer set search_path = public as $$
  select distinct l.thread_id
    from crm_email_thread_contacts l
    join crm_contacts c on c.id = l.contact_id
   where (p_company is not null or p_contact is not null)
     and (p_contact is null or l.contact_id = p_contact)
     and (p_company is null or c.company_id = p_company)
$$;
revoke all on function public.crm_linked_thread_ids(uuid, uuid) from public, anon, authenticated;

-- crm_timeline_rows (192) + email activities of linked threads. Same signature and output.
drop function if exists public.crm_timeline_rows(uuid, uuid, text[], timestamptz, uuid, int);
create or replace function public.crm_timeline_rows(
  p_company uuid, p_contact uuid, p_types text[], p_before timestamptz, p_before_id uuid, p_limit int default 25)
returns table (activity_id uuid, thread_id uuid, occurred_at timestamptz, message_count int, activity_ids uuid[])
language sql stable security definer set search_path = public as $$
  with own as (
    select a.id, a.type, a.occurred_at, a.metadata
      from crm_activities a
     where (p_company is null or a.company_id = p_company)
       and (p_contact is null or a.contact_id = p_contact)
       and (p_company is not null or p_contact is not null)
       and (p_types is null or a.type = any (p_types))
  ),
  linked as (
    select a.id, a.type, a.occurred_at, a.metadata
      from crm_linked_thread_ids(p_company, p_contact) t
      join crm_emails e on e.thread_id = t
      join crm_activities a on a.id = e.activity_id
     where p_types is null or 'email' = any (p_types)
  ),
  acts as (
    select id, type, occurred_at,
           case when type = 'email' and (metadata ->> 'thread_id') ~ '^[0-9a-f-]{36}$' then (metadata ->> 'thread_id')::uuid end as tid
      from (select * from own union select * from linked) x
  ),
  threads as (
    select distinct on (tid) id, tid, occurred_at, (count(*) over (partition by tid))::int as n,
           array_agg(id) over (partition by tid) as ids
      from acts where tid is not null
     order by tid, occurred_at desc, id desc
  ),
  rows as (
    select id, null::uuid as tid, occurred_at, 1 as n, array[id] as ids from acts where tid is null
    union all
    select id, tid, occurred_at, n, ids from threads
  )
  select id, tid, occurred_at, n, ids from rows
   where p_before is null or (occurred_at, id) < (p_before, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid))
   order by occurred_at desc, id desc
   limit greatest(1, least(coalesce(p_limit, 25), 100))
$$;
revoke all on function public.crm_timeline_rows(uuid, uuid, text[], timestamptz, uuid, int) from public, anon, authenticated;
