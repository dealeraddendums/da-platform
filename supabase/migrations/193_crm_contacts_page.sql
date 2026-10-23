-- 193_crm_contacts_page.sql — DA-CRM Contacts list: search, sort and "group by person" in one query.
--
-- crm_contacts_page(q, sort, desc, group, company, users, limit, offset):
--   q       matches name, email, company name, and phone digits (≥ 4 digits, either the E.164 phone or the
--           as-typed phone_raw)
--   sort    name | company | title | email | phone | last_activity  (nulls always last; ties → last activity)
--   group   true: rows with the same email collapse to one "person" row (companies listed); contacts with
--           no email stay one row each. The representative contact is the platform user, else the newest.
--   company / users   the company page's "CRM Users" link (one company; platform users only)
-- Returns one row per person (or contact) plus `total` (rows before paging).

create or replace function public.crm_contacts_page(
  p_q text, p_sort text, p_desc boolean, p_group boolean, p_company uuid, p_users boolean, p_limit int, p_offset int)
returns table (
  row_key text, contact_id uuid, contact_ids uuid[], name text, email text, phone text, phone_raw text,
  title text, role_tag text, companies jsonb, company_count int, is_user boolean, needs_verify boolean,
  last_activity_at timestamptz, total bigint)
language sql stable security definer set search_path = public as $$
  with la as (
    select contact_id, max(occurred_at) as at from crm_activities where contact_id is not null group by 1
  ),
  base as (
    select k.id, k.email, k.phone, k.phone_raw, k.title, k.role_tag, k.user_id, k.updated_at, k.company_id,
           nullif(btrim(coalesce(k.first_name, '') || ' ' || coalesce(k.last_name, '')), '') as full_name,
           coalesce(c.name, d.name, g.name) as company_name,
           (k.verify_reason is not null and k.verified_at is null) as weak,
           la.at as last_at
      from crm_contacts k
      join crm_companies c on c.id = k.company_id
      left join dealers d on d.id = c.dealer_id
      left join groups g on g.id = c.group_id
      left join la on la.contact_id = k.id
     where k.deleted_at is null
       and (p_company is null or k.company_id = p_company)
       and (not coalesce(p_users, false) or k.user_id is not null)
  ),
  hit as (
    select * from base b
     where coalesce(btrim(p_q), '') = ''
        or b.full_name ilike '%' || btrim(p_q) || '%'
        or b.email ilike '%' || btrim(p_q) || '%'
        or b.company_name ilike '%' || btrim(p_q) || '%'
        or (length(regexp_replace(p_q, '\D', '', 'g')) >= 4
            and regexp_replace(coalesce(b.phone, b.phone_raw, ''), '\D', '', 'g') like '%' || regexp_replace(p_q, '\D', '', 'g') || '%')
  ),
  -- With grouping on, every contact that shares an email with a hit comes along (the person's other companies).
  scope as (
    select b.* from base b
     where not coalesce(p_group, true) and b.id in (select id from hit)
        or coalesce(p_group, true) and (b.id in (select id from hit)
             or (b.email is not null and lower(b.email) in (select lower(email) from hit where email is not null)))
  ),
  keyed as (
    select s.*, case when coalesce(p_group, true) and s.email is not null then 'e:' || lower(s.email) else 'c:' || s.id end as k
      from scope s
  ),
  grouped as (
    select k as row_key,
           (array_agg(id order by (user_id is not null) desc, updated_at desc))[1] as contact_id,
           array_agg(id order by (user_id is not null) desc, updated_at desc) as contact_ids,
           (array_agg(full_name order by (user_id is not null) desc, (full_name is null), updated_at desc))[1] as name,
           (array_agg(email order by (user_id is not null) desc, updated_at desc))[1] as email,
           (array_agg(phone order by (phone is null), (user_id is not null) desc, updated_at desc))[1] as phone,
           (array_agg(phone_raw order by (phone_raw is null), updated_at desc))[1] as phone_raw,
           (array_agg(title order by (title is null), (user_id is not null) desc, updated_at desc))[1] as title,
           (array_agg(role_tag order by (role_tag is null), (user_id is not null) desc, updated_at desc))[1] as role_tag,
           jsonb_agg(jsonb_build_object('id', company_id, 'name', company_name, 'contact_id', id, 'is_user', user_id is not null, 'needs_verify', weak)
                     order by company_name) as companies,
           count(distinct company_id)::int as company_count,
           bool_or(user_id is not null) as is_user,
           bool_or(weak) as needs_verify,
           max(last_at) as last_activity_at,
           min(lower(company_name)) as company_sort
      from keyed group by k
  )
  select row_key, contact_id, contact_ids, name, email, phone, phone_raw, title, role_tag, companies, company_count,
         is_user, needs_verify, last_activity_at, count(*) over () as total
    from grouped
   order by
     case when not coalesce(p_desc, false) then
       case p_sort when 'name' then lower(coalesce(name, email)) when 'company' then company_sort when 'title' then lower(coalesce(title, role_tag))
                   when 'email' then lower(email) when 'phone' then coalesce(phone, phone_raw) end end asc nulls last,
     case when coalesce(p_desc, false) then
       case p_sort when 'name' then lower(coalesce(name, email)) when 'company' then company_sort when 'title' then lower(coalesce(title, role_tag))
                   when 'email' then lower(email) when 'phone' then coalesce(phone, phone_raw) end end desc nulls last,
     case when p_sort = 'last_activity' and not coalesce(p_desc, true) then last_activity_at end asc nulls last,
     last_activity_at desc nulls last,
     row_key
   limit greatest(1, least(coalesce(p_limit, 50), 200)) offset greatest(0, coalesce(p_offset, 0))
$$;
revoke all on function public.crm_contacts_page(text, text, boolean, boolean, uuid, boolean, int, int) from public, anon, authenticated;
