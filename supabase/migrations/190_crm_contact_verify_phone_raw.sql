-- 190_crm_contact_verify_phone_raw.sql — DA-CRM contacts: "verify" flag on record contacts whose email
-- domain isn't the company's, and phone_raw for phones that won't parse to E.164.
--
-- Record contacts (source dealer_record / group_record) come from dealers.primary_contact_email, which is
-- often a vendor's or agency's address (detailing, coating, IT resellers). Those must not bind mail to the
-- dealer. A record contact is flagged (verify_reason) when the company has domain evidence and the
-- contact's domain isn't in it. Flagged, unverified contacts are "weak": email matching never links a
-- thread to them on its own — they only become a candidate (lib/crm/inbox-match.ts, contact-rematch.ts).
-- Staff clear the flag with "Mark verified" (verified_at / verified_by).
--
-- Domain evidence (crm_company_domains, refreshed by crm_refresh_company_domains(), nightly via
-- crm_contacts_reconcile): the dealer / CRM website, the hosts of the dealer's inventory VDP links, its
-- platform users' email domains (not free-mail), and its group's — a group's evidence is its own plus its
-- member dealers', a dealer also gets its group's (corporate addresses like @penskeautomotive.com).

-- ── Domains ─────────────────────────────────────────────────────────────────
create or replace function public.crm_base_domain(p_host text) returns text language sql immutable as $$
  select case
    when h is null or h = '' then null
    when h ~ '\.(co|com|net|org|gov|ac)\.[a-z]{2}$' then substring(h from '([^.]+\.[^.]+\.[^.]+)$')
    else coalesce(substring(h from '([^.]+\.[^.]+)$'), h) end
  from (select lower(btrim(regexp_replace(coalesce(p_host, ''), '^\s*(https?://)?(www\d*\.)?([^/:?#\s@]+).*$', '\3'))) h) x
$$;

create or replace function public.crm_is_freemail(p_domain text) returns boolean language sql immutable as $$
  select lower(coalesce(p_domain, '')) = any (array['gmail.com','googlemail.com','yahoo.com','ymail.com','hotmail.com','outlook.com',
    'live.com','msn.com','aol.com','icloud.com','me.com','mac.com','comcast.net','att.net','sbcglobal.net','verizon.net',
    'bellsouth.net','cox.net','charter.net','rr.com','earthlink.net','protonmail.com','proton.me','gmx.com','mail.com'])
$$;

create table if not exists public.crm_company_domains (
  company_id uuid not null references public.crm_companies(id) on delete cascade,
  domain text not null,
  source text not null,              -- website | vdp | users | group | members
  primary key (company_id, domain)
);
alter table public.crm_company_domains enable row level security;
revoke all on public.crm_company_domains from anon, authenticated;

create or replace function public.crm_refresh_company_domains() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  drop table if exists pg_temp._d;
  create temp table _d (company_id uuid, domain text, source text) on commit drop;
  insert into _d
    select c.id, crm_base_domain(d.website_url), 'website' from crm_companies c join dealers d on d.id = c.dealer_id where nullif(btrim(d.website_url), '') is not null
    union all select c.id, crm_base_domain(c.website), 'website' from crm_companies c where nullif(btrim(c.website), '') is not null
    union all
    select c.id, v.dom, 'vdp' from crm_companies c join dealers d on d.id = c.dealer_id
      join (select dealer_id, crm_base_domain(substring(lower(vdp_link) from '^https?://([^/:?#]+)')) dom
              from dealer_vehicles where vdp_link ~* '^https?://' group by 1, 2) v on v.dealer_id = d.dealer_id
    union all
    select k.company_id, crm_base_domain(split_part(k.email, '@', 2)), 'users' from crm_contacts k
      where k.source = 'platform_user' and k.deleted_at is null and k.email like '%@%';
  -- a group gets its member dealers' evidence; a dealer gets its group's
  insert into _d
    select g.id, x.domain, 'members' from crm_companies g join dealers d on d.group_id = g.group_id
      join crm_companies dc on dc.dealer_id = d.id join _d x on x.company_id = dc.id where g.kind = 'group';
  insert into _d
    select dc.id, x.domain, 'group' from crm_companies dc join dealers d on d.id = dc.dealer_id
      join crm_companies g on g.group_id = d.group_id join _d x on x.company_id = g.id where x.source in ('website', 'users', 'members');
  delete from crm_company_domains;
  insert into crm_company_domains (company_id, domain, source)
    select distinct on (company_id, domain) company_id, domain, source from _d
     where domain is not null and domain like '%.%' and not crm_is_freemail(domain)
     order by company_id, domain, source;
  get diagnostics n = row_count;
  return n;
end $$;

-- ── Verify flag ─────────────────────────────────────────────────────────────
alter table public.crm_contacts
  add column if not exists verify_reason text,          -- domain_mismatch | freemail (record contacts only)
  add column if not exists verified_at timestamptz,
  add column if not exists verified_by uuid,
  add column if not exists phone_raw text;              -- as typed, when it doesn't parse to E.164

alter table public.crm_contacts drop constraint if exists crm_contacts_verify_reason_check;
alter table public.crm_contacts add constraint crm_contacts_verify_reason_check
  check (verify_reason is null or verify_reason in ('domain_mismatch', 'freemail'));

/** Why a record contact needs verifying, or null (no evidence → null: nothing to compare against). */
create or replace function public.crm_contact_verify_reason(p_company uuid, p_email text) returns text
language sql stable as $$
  select case
    when p_email is null or position('@' in p_email) = 0 then null
    when not exists (select 1 from crm_company_domains where company_id = p_company) then null
    when exists (select 1 from crm_company_domains where company_id = p_company and domain = crm_base_domain(split_part(p_email, '@', 2))) then null
    when crm_is_freemail(crm_base_domain(split_part(p_email, '@', 2))) then 'freemail'
    else 'domain_mismatch' end
$$;

/** Re-flag every unverified live record contact. Returns how many are flagged. */
create or replace function public.crm_flag_record_contacts(p_apply boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
declare flagged int; changed int; no_evidence int;
begin
  select count(*) into changed from crm_contacts k
   where k.source in ('dealer_record', 'group_record') and k.deleted_at is null and k.verified_at is null
     and k.verify_reason is distinct from crm_contact_verify_reason(k.company_id, k.email);
  if p_apply then
    update crm_contacts k set verify_reason = crm_contact_verify_reason(k.company_id, k.email), updated_at = now()
     where k.source in ('dealer_record', 'group_record') and k.deleted_at is null and k.verified_at is null
       and k.verify_reason is distinct from crm_contact_verify_reason(k.company_id, k.email);
  end if;
  select count(*) into flagged from crm_contacts k
   where k.source in ('dealer_record', 'group_record') and k.deleted_at is null and k.verified_at is null
     and crm_contact_verify_reason(k.company_id, k.email) is not null;
  select count(*) into no_evidence from crm_contacts k
   where k.source in ('dealer_record', 'group_record') and k.deleted_at is null and k.email is not null
     and not exists (select 1 from crm_company_domains d where d.company_id = k.company_id);
  return jsonb_build_object('flagged', flagged, 'changed', changed, 'no_domain_evidence', no_evidence);
end $$;

-- New record contacts get flagged as they're created.
create or replace function public.crm_sync_record_contact(p_company uuid, p_apply boolean default true)
returns text language plpgsql security definer set search_path = public as $$
declare e record; hit boolean;
begin
  select * into e from crm_expected_record_contacts where company_id = p_company limit 1;
  if e.company_id is null then return 'skipped'; end if;
  if e.email is not null then
    select exists (select 1 from crm_contacts where company_id = p_company and lower(email) = e.email and deleted_at is null) into hit;
  else
    select exists (select 1 from crm_contacts where company_id = p_company and deleted_at is null
                    and lower(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) = lower(coalesce(e.first_name, '') || ' ' || coalesce(e.last_name, ''))) into hit;
  end if;
  -- A record contact the team deleted stays deleted.
  if not hit then
    select exists (select 1 from crm_contacts where company_id = p_company and source = e.source and deleted_at is not null
                    and (lower(email) = e.email or (e.email is null and email is null and first_name is not distinct from e.first_name and last_name is not distinct from e.last_name))) into hit;
  end if;
  if hit then return 'covered'; end if;
  if p_apply then
    insert into crm_contacts (company_id, first_name, last_name, email, source, verify_reason)
    values (p_company, e.first_name, e.last_name, e.email, e.source, crm_contact_verify_reason(p_company, e.email));
  end if;
  return 'created';
end $$;

-- ── phone_raw: keep the platform's as-typed phone when it won't parse ───────
create or replace view public.crm_expected_user_contacts with (security_invoker = true) as
select p.id as user_id, x.company_id, n.first_name, n.last_name, lower(nullif(btrim(p.email), '')) as email,
       public.crm_normalize_phone(p.phone) as phone, public.crm_user_role_tag(p.role) as role_tag,
       (p.active is false) as disabled,
       case when public.crm_normalize_phone(p.phone) is null then nullif(btrim(p.phone), '') end as phone_raw
from public.profiles p
cross join lateral (select public.crm_user_company_id(p) as company_id) x
cross join lateral public.crm_split_name(p.full_name) n
where x.company_id is not null;
revoke all on public.crm_expected_user_contacts from public, anon, authenticated;

create or replace function public.crm_sync_user_contact(p_user uuid, p_fields boolean default true, p_apply boolean default true)
returns text language plpgsql security definer set search_path = public as $$
declare
  e record; c crm_contacts; dup crm_contacts; act text;
begin
  select * into e from crm_expected_user_contacts where user_id = p_user;
  select * into c from crm_contacts where user_id = p_user order by (deleted_at is null) desc, updated_at desc limit 1;

  if e.user_id is null then
    if c.id is not null and c.deleted_at is null then
      if p_apply then update crm_contacts set deleted_at = now(), updated_at = now() where id = c.id; end if;
      return 'disabled';
    end if;
    return 'skipped';
  end if;

  if e.email is not null then
    select * into dup from crm_contacts
     where company_id = e.company_id and lower(email) = e.email and deleted_at is null and id is distinct from c.id
     limit 1;
  end if;
  if dup.id is not null and dup.user_id is not null and dup.user_id <> p_user then return 'conflict'; end if;

  if c.id is null then
    if dup.id is not null then
      if p_apply then
        update crm_contacts set user_id = p_user, source = 'platform_user', verify_reason = null,
               first_name = coalesce(e.first_name, first_name), last_name = coalesce(e.last_name, last_name),
               phone = coalesce(e.phone, phone), phone_raw = case when coalesce(e.phone, phone) is null then coalesce(e.phone_raw, phone_raw) end,
               role_tag = coalesce(role_tag, e.role_tag),
               deleted_at = case when e.disabled then now() else null end, updated_at = now()
         where id = dup.id;
      end if;
      return 'attached';
    end if;
    if p_apply then
      insert into crm_contacts (company_id, user_id, first_name, last_name, email, phone, phone_raw, role_tag, source, deleted_at)
      values (e.company_id, p_user, e.first_name, e.last_name, e.email, e.phone, e.phone_raw, e.role_tag, 'platform_user',
              case when e.disabled then now() end);
    end if;
    return 'created';
  end if;

  act := case
    when dup.id is not null then 'merged'
    when c.company_id <> e.company_id then 'moved'
    when e.disabled and c.deleted_at is null then 'disabled'
    when not e.disabled and c.deleted_at is not null then 'enabled'
    when c.email is distinct from e.email or c.source <> 'platform_user'
      or (p_fields and ((c.first_name, c.last_name, c.role_tag) is distinct from (e.first_name, e.last_name, e.role_tag)
                        or ((e.phone is not null or e.phone_raw is not null) and (c.phone, c.phone_raw) is distinct from (e.phone, e.phone_raw))))
      or (not p_fields and ((c.first_name is null and e.first_name is not null) or (c.last_name is null and e.last_name is not null)
                            or (c.phone is null and e.phone is not null)
                            or (c.phone is null and c.phone_raw is null and e.phone_raw is not null)
                            or (c.role_tag is null and e.role_tag is not null)))
      then 'updated'
    else 'unchanged' end;
  if act = 'unchanged' or not p_apply then return act; end if;

  if dup.id is not null then perform crm_merge_contact(dup.id, c.id); end if;
  update crm_contacts set
    company_id = e.company_id, email = e.email, source = 'platform_user', verify_reason = null,
    first_name = case when p_fields then coalesce(e.first_name, first_name) else coalesce(first_name, e.first_name) end,
    last_name  = case when p_fields then coalesce(e.last_name, last_name)   else coalesce(last_name, e.last_name) end,
    -- The profile has a phone → mirror it (parsed, or as typed in phone_raw). No profile phone → keep the CRM's.
    phone      = case when p_fields and (e.phone is not null or e.phone_raw is not null) then e.phone
                      when p_fields then phone else coalesce(phone, e.phone) end,
    phone_raw  = case when p_fields and (e.phone is not null or e.phone_raw is not null) then e.phone_raw
                      when coalesce(phone, e.phone) is not null then null
                      else coalesce(phone_raw, e.phone_raw) end,
    role_tag   = case when p_fields then coalesce(e.role_tag, role_tag)     else coalesce(role_tag, e.role_tag) end,
    deleted_at = case when e.disabled then coalesce(deleted_at, now()) else null end,
    updated_at = now()
  where id = c.id;
  update crm_contacts set deleted_at = now(), updated_at = now()
   where user_id = p_user and id <> c.id and deleted_at is null;
  return act;
end $$;

-- ── Nightly reconcile: refresh domains + flags too ──────────────────────────
create or replace function public.crm_contacts_reconcile(p_apply boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r record; a text; users jsonb := '{}'::jsonb; recs jsonb := '{}'::jsonb; conflicts jsonb := '[]'::jsonb;
  unmapped int; bad_phone int; out jsonb; doms int; flags jsonb;
begin
  for r in select id from profiles union select user_id from crm_contacts where user_id is not null loop
    a := crm_sync_user_contact(r.id, false, p_apply);
    users := jsonb_set(users, array[a], to_jsonb(coalesce((users ->> a)::int, 0) + 1));
    if a = 'conflict' and jsonb_array_length(conflicts) < 20 then conflicts := conflicts || to_jsonb(r.id); end if;
  end loop;
  if p_apply then doms := crm_refresh_company_domains(); end if;
  for r in select distinct company_id from crm_expected_record_contacts loop
    a := crm_sync_record_contact(r.company_id, p_apply);
    recs := jsonb_set(recs, array[a], to_jsonb(coalesce((recs ->> a)::int, 0) + 1));
  end loop;
  flags := crm_flag_record_contacts(p_apply);
  select count(*) into unmapped from profiles p
   where p.role <> 'super_admin' and not coalesce(p.test_account, false) and public.crm_user_company_id(p) is null;
  select count(*) into bad_phone from profiles p
   where nullif(btrim(p.phone), '') is not null and public.crm_normalize_phone(p.phone) is null and public.crm_user_company_id(p) is not null;
  out := jsonb_build_object(
    'applied', p_apply, 'users', users, 'records', recs, 'user_conflicts', conflicts,
    'users_without_company', unmapped, 'unparseable_user_phones', bad_phone, 'verify', flags, 'company_domains', doms);
  if p_apply then
    out := out || jsonb_build_object(
      'live_by_source', (select coalesce(jsonb_object_agg(source, n), '{}') from (select source, count(*) n from crm_contacts where deleted_at is null group by 1) s),
      'live_by_role_tag', (select coalesce(jsonb_object_agg(coalesce(role_tag, 'none'), n), '{}') from (select role_tag, count(*) n from crm_contacts where deleted_at is null group by 1) s),
      'soft_deleted', (select count(*) from crm_contacts where deleted_at is not null),
      'dealers_and_groups_without_contact', (select count(*) from crm_companies co where co.kind in ('dealer', 'group')
         and not exists (select 1 from crm_contacts k where k.company_id = co.id and k.deleted_at is null)),
      'active_dealers_without_contact', (select count(*) from crm_companies co join dealers d on d.id = co.dealer_id where d.active
         and not exists (select 1 from crm_contacts k where k.company_id = co.id and k.deleted_at is null)));
  end if;
  return out;
end $$;

revoke all on function public.crm_refresh_company_domains(), public.crm_flag_record_contacts(boolean),
  public.crm_contact_verify_reason(uuid, text) from public, anon, authenticated;
