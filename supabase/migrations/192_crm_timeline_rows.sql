-- 192_crm_timeline_rows.sql — DA-CRM activity timeline: one row per activity, one row per email thread.
--
-- crm_timeline_rows(company | contact, types, cursor, limit) pages the timeline newest first. Emails of
-- the same thread collapse into ONE row, placed at the thread's newest message (activity_id = that
-- message's activity) with the thread's message count and all its activity ids (so a Summary source
-- pointing at an older message finds its row). Cursor = (occurred_at, activity_id) of the last
-- row; pass both to get the next page. types null = everything.
--
-- Attribution: an email activity's "who" is the message's sender, never the thread contact. Email
-- activities carry metadata.from_name / from_email / sender_email (inbox-ingest writes them from now on);
-- existing rows are back-filled from crm_emails, and their direction is set from the message (our
-- mailbox's point of view).

drop function if exists public.crm_timeline_rows(uuid, uuid, text[], timestamptz, uuid, int);
create or replace function public.crm_timeline_rows(
  p_company uuid, p_contact uuid, p_types text[], p_before timestamptz, p_before_id uuid, p_limit int default 25)
returns table (activity_id uuid, thread_id uuid, occurred_at timestamptz, message_count int, activity_ids uuid[])
language sql stable security definer set search_path = public as $$
  with acts as (
    select a.id, a.type, a.occurred_at,
           case when a.type = 'email' and (a.metadata ->> 'thread_id') ~ '^[0-9a-f-]{36}$' then (a.metadata ->> 'thread_id')::uuid end as tid
      from crm_activities a
     where (p_company is null or a.company_id = p_company)
       and (p_contact is null or a.contact_id = p_contact)
       and (p_company is not null or p_contact is not null)
       and (p_types is null or a.type = any (p_types))
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

-- Back-fill: sender + direction on existing email activities, from the message itself.
update public.crm_activities a
   set metadata = coalesce(a.metadata, '{}'::jsonb)
         || jsonb_build_object('from_name', e.from_name, 'from_email', lower(e.from_email), 'sender_email', lower(e.sender_email)),
       direction = coalesce(e.direction, a.direction)
  from public.crm_emails e
 where e.activity_id = a.id and a.type = 'email'
   and (a.metadata ->> 'from_email' is distinct from lower(e.from_email)
        or a.metadata ->> 'from_name' is distinct from e.from_name
        or a.direction is distinct from coalesce(e.direction, a.direction)
        or not (a.metadata ? 'sender_email'));
