-- 188_crm_contacts_from_users.sql — DA-CRM contacts follow the platform's users.
--
-- One crm_contacts row per platform user (source 'platform_user', user_id set) on that user's company:
--   dealer roles  (dealer_admin, dealer_user, dealer_restricted) → the dealer's crm_companies row
--                 (profiles.dealer_id is the dealer's text id, dealers.dealer_id)
--   group roles   (group_admin, group_user) → the group's row; per-dealer access adds nothing extra.
--                 A group role with no group_id falls back to its dealer.
--   super_admin (staff) and test accounts never become contacts.
-- role_tag: dealer_admin / group_admin → admin; dealer_user / group_user / dealer_restricted → other.
-- Names: profiles.full_name split at the first space. Email lowercased. Phone E.164 via crm_normalize_phone
-- (crm_contacts.phone is E.164-only; an unparseable platform phone is left blank and counted).
--
-- Plus the dealer / group record's own primary contact (source 'dealer_record' / 'group_record') when that
-- person isn't already a contact at the company. Record contacts are only ever added, never edited or removed.
--
-- Dedupe: one live row per (company_id, lower(email)) — the existing unique index. A user that collides with
-- a non-user row takes that row over (user_id set); a user's own row that collides with another non-user row
-- absorbs it (references repointed, the other soft-deleted). Two users with one email at one company: the
-- first keeps the contact, the second is reported as a conflict.
--
-- Live: triggers on profiles (insert / update / delete) and on dealers / groups (primary contact) run in the
-- same transaction and never block the platform's write (failures RAISE WARNING). Disable (active = false),
-- delete, or no longer mapping → deleted_at; re-enable clears it. Nightly: crm_contacts_reconcile(true)
-- (POST /api/cron/crm-contacts-reconcile, 01:45 PT) re-applies everything and reports drift.

-- ── Mapping helpers ─────────────────────────────────────────────────────────
create or replace function public.crm_split_name(p_full text, out first_name text, out last_name text)
language plpgsql immutable as $$
declare t text := nullif(btrim(regexp_replace(coalesce(p_full, ''), '\s+', ' ', 'g')), '');
begin
  if t is null then return; end if;
  first_name := split_part(t, ' ', 1);
  last_name := nullif(substr(t, length(first_name) + 2), '');
end $$;

create or replace function public.crm_user_role_tag(p_role text) returns text
language sql immutable as $$
  select case p_role
    when 'dealer_admin' then 'admin' when 'group_admin' then 'admin'
    when 'dealer_user' then 'other' when 'group_user' then 'other' when 'dealer_restricted' then 'other'
    else null end
$$;

/** A plausible single email address, lowercased; null for blanks, lists and junk. */
create or replace function public.crm_clean_email(p_raw text) returns text
language sql immutable as $$
  select case when lower(btrim(coalesce(p_raw, ''))) ~ '^[a-z0-9._%+''-]+@[a-z0-9.-]+\.[a-z]{2,}$'
              then lower(btrim(p_raw)) end
$$;

create or replace function public.crm_user_company_id(p public.profiles) returns uuid
language sql stable as $$
  select case
    when p.role = 'super_admin' or coalesce(p.test_account, false) then null
    when p.role in ('group_admin', 'group_user') and p.group_id is not null
      then (select c.id from public.crm_companies c where c.group_id = p.group_id)
    when p.dealer_id is not null
      then coalesce(
        (select c.id from public.crm_companies c join public.dealers d on d.id = c.dealer_id where d.dealer_id = p.dealer_id limit 1),
        (select c.id from public.crm_companies c where p.group_id is not null and c.group_id = p.group_id))
    when p.group_id is not null
      then (select c.id from public.crm_companies c where c.group_id = p.group_id)
  end
$$;

-- What every user's contact should look like (users that map to a company only).
create or replace view public.crm_expected_user_contacts with (security_invoker = true) as
select p.id as user_id, x.company_id, n.first_name, n.last_name, lower(nullif(btrim(p.email), '')) as email,
       public.crm_normalize_phone(p.phone) as phone, public.crm_user_role_tag(p.role) as role_tag,
       (p.active is false) as disabled
from public.profiles p
cross join lateral (select public.crm_user_company_id(p) as company_id) x
cross join lateral public.crm_split_name(p.full_name) n
where x.company_id is not null;

-- ── Merge: move everything that points at one contact to another ────────────
create or replace function public.crm_merge_contact(p_from uuid, p_into uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_from = p_into then return; end if;
  update crm_activities   set contact_id = p_into where contact_id = p_from;
  update crm_calls        set contact_id = p_into where contact_id = p_from;
  update crm_email_threads set contact_id = p_into where contact_id = p_from;
  update crm_tickets      set contact_id = p_into where contact_id = p_from;
  update crm_tasks        set contact_id = p_into where contact_id = p_from;
  update crm_contacts set deleted_at = coalesce(deleted_at, now()), updated_at = now() where id = p_from;
end $$;

-- ── One user → one contact ──────────────────────────────────────────────────
-- p_fields: copy name / phone / role_tag from the platform (true when the profile itself changed);
--           false (reconcile) only fills blanks, so CRM edits to names and roles stick.
-- p_apply:  false = dry run, returns the action without writing.
-- Returns: created | attached | merged | moved | updated | disabled | enabled | unchanged | skipped | conflict
create or replace function public.crm_sync_user_contact(p_user uuid, p_fields boolean default true, p_apply boolean default true)
returns text language plpgsql security definer set search_path = public as $$
declare
  e record; c crm_contacts; dup crm_contacts; act text;
begin
  select * into e from crm_expected_user_contacts where user_id = p_user;
  select * into c from crm_contacts where user_id = p_user order by (deleted_at is null) desc, updated_at desc limit 1;

  if e.user_id is null then                                   -- no longer maps (or staff / test / no company)
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
    if dup.id is not null then                                -- take over the record / manual contact
      if p_apply then
        update crm_contacts set user_id = p_user, source = 'platform_user',
               first_name = coalesce(e.first_name, first_name), last_name = coalesce(e.last_name, last_name),
               phone = coalesce(e.phone, phone), role_tag = coalesce(role_tag, e.role_tag),
               deleted_at = case when e.disabled then now() else null end, updated_at = now()
         where id = dup.id;
      end if;
      return 'attached';
    end if;
    if p_apply then
      insert into crm_contacts (company_id, user_id, first_name, last_name, email, phone, role_tag, source, deleted_at)
      values (e.company_id, p_user, e.first_name, e.last_name, e.email, e.phone, e.role_tag, 'platform_user',
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
      or (p_fields and (c.first_name, c.last_name, c.phone, c.role_tag) is distinct from (e.first_name, e.last_name, e.phone, e.role_tag))
      or (not p_fields and ((c.first_name is null and e.first_name is not null) or (c.last_name is null and e.last_name is not null)
                            or (c.phone is null and e.phone is not null) or (c.role_tag is null and e.role_tag is not null)))
      then 'updated'
    else 'unchanged' end;
  if act = 'unchanged' or not p_apply then return act; end if;

  if dup.id is not null then perform crm_merge_contact(dup.id, c.id); end if;
  update crm_contacts set
    company_id = e.company_id, email = e.email, source = 'platform_user',
    first_name = case when p_fields then coalesce(e.first_name, first_name) else coalesce(first_name, e.first_name) end,
    last_name  = case when p_fields then coalesce(e.last_name, last_name)   else coalesce(last_name, e.last_name) end,
    phone      = case when p_fields then coalesce(e.phone, phone)           else coalesce(phone, e.phone) end,
    role_tag   = case when p_fields then coalesce(e.role_tag, role_tag)     else coalesce(role_tag, e.role_tag) end,
    deleted_at = case when e.disabled then coalesce(deleted_at, now()) else null end,
    updated_at = now()
  where id = c.id;
  -- Older duplicate rows for the same user (shouldn't exist): retire them.
  update crm_contacts set deleted_at = now(), updated_at = now()
   where user_id = p_user and id <> c.id and deleted_at is null;
  return act;
end $$;

-- ── Dealer / group record primary contacts ──────────────────────────────────
create or replace view public.crm_expected_record_contacts with (security_invoker = true) as
select c.id as company_id, 'dealer_record'::text as source, n.first_name, n.last_name, public.crm_clean_email(d.primary_contact_email) as email
from public.dealers d join public.crm_companies c on c.dealer_id = d.id
cross join lateral public.crm_split_name(
  case when lower(btrim(coalesce(d.primary_contact, ''))) in ('', lower(btrim(coalesce(d.name, '')))) then null else d.primary_contact end) n
where public.crm_clean_email(d.primary_contact_email) is not null or n.first_name is not null
union all
select c.id, 'group_record', n.first_name, n.last_name, public.crm_clean_email(g.primary_contact_email)
from public.groups g join public.crm_companies c on c.group_id = g.id
cross join lateral public.crm_split_name(
  case when lower(btrim(coalesce(g.primary_contact, ''))) in ('', lower(btrim(coalesce(g.name, '')))) then null else g.primary_contact end) n
where public.crm_clean_email(g.primary_contact_email) is not null or n.first_name is not null;

-- Returns created | covered (already a contact at the company).
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
    insert into crm_contacts (company_id, first_name, last_name, email, source) values (p_company, e.first_name, e.last_name, e.email, e.source);
  end if;
  return 'created';
end $$;

-- ── Reconcile / backfill ────────────────────────────────────────────────────
-- crm_contacts_reconcile(false) = dry run. Users first (so record contacts that are users get absorbed), then
-- records. Returns counts by action, by source / role_tag, companies with no live contact, and a sample.
create or replace function public.crm_contacts_reconcile(p_apply boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r record; a text; users jsonb := '{}'::jsonb; recs jsonb := '{}'::jsonb; conflicts jsonb := '[]'::jsonb;
  unmapped int; bad_phone int; out jsonb;
begin
  for r in select id from profiles union select user_id from crm_contacts where user_id is not null loop
    a := crm_sync_user_contact(r.id, false, p_apply);
    users := jsonb_set(users, array[a], to_jsonb(coalesce((users ->> a)::int, 0) + 1));
    if a = 'conflict' and jsonb_array_length(conflicts) < 20 then conflicts := conflicts || to_jsonb(r.id); end if;
  end loop;
  for r in select distinct company_id from crm_expected_record_contacts loop
    a := crm_sync_record_contact(r.company_id, p_apply);
    recs := jsonb_set(recs, array[a], to_jsonb(coalesce((recs ->> a)::int, 0) + 1));
  end loop;
  select count(*) into unmapped from profiles p
   where p.role <> 'super_admin' and not coalesce(p.test_account, false) and public.crm_user_company_id(p) is null;
  select count(*) into bad_phone from profiles p
   where nullif(btrim(p.phone), '') is not null and public.crm_normalize_phone(p.phone) is null and public.crm_user_company_id(p) is not null;
  out := jsonb_build_object(
    'applied', p_apply, 'users', users, 'records', recs, 'user_conflicts', conflicts,
    'users_without_company', unmapped, 'unparseable_user_phones', bad_phone);
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

-- ── Live triggers ───────────────────────────────────────────────────────────
create or replace function public.crm_profiles_contact_sync() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    begin
      update crm_contacts set deleted_at = coalesce(deleted_at, now()), updated_at = now() where user_id = old.id and deleted_at is null;
    exception when others then raise warning 'crm contact sync (delete %) failed: %', old.id, sqlerrm;
    end;
    return old;
  end if;
  if tg_op = 'UPDATE' and (new.email, new.full_name, new.phone, new.role, new.dealer_id, new.group_id, new.active, new.test_account)
     is not distinct from (old.email, old.full_name, old.phone, old.role, old.dealer_id, old.group_id, old.active, old.test_account) then
    return new;
  end if;
  begin
    perform crm_sync_user_contact(new.id, true, true);
  exception when others then raise warning 'crm contact sync (%) failed: %', new.id, sqlerrm;
  end;
  return new;
end $$;

drop trigger if exists profiles_crm_contact_sync on public.profiles;
create trigger profiles_crm_contact_sync after insert or update on public.profiles
  for each row execute function public.crm_profiles_contact_sync();
-- BEFORE DELETE: crm_contacts.user_id is ON DELETE SET NULL, so soft-delete while the link still exists.
drop trigger if exists profiles_crm_contact_delete on public.profiles;
create trigger profiles_crm_contact_delete before delete on public.profiles
  for each row execute function public.crm_profiles_contact_sync();

create or replace function public.crm_record_contact_sync() returns trigger
language plpgsql security definer set search_path = public as $$
declare co uuid;
begin
  if (new.primary_contact, new.primary_contact_email) is not distinct from (old.primary_contact, old.primary_contact_email) then return new; end if;
  begin
    if tg_table_name = 'dealers' then select id into co from crm_companies where dealer_id = new.id;
    else select id into co from crm_companies where group_id = new.id; end if;
    if co is not null then perform crm_sync_record_contact(co, true); end if;
  exception when others then raise warning 'crm record contact sync (%) failed: %', new.id, sqlerrm;
  end;
  return new;
end $$;

drop trigger if exists dealers_crm_record_contact on public.dealers;
create trigger dealers_crm_record_contact after update of primary_contact, primary_contact_email on public.dealers
  for each row execute function public.crm_record_contact_sync();
drop trigger if exists groups_crm_record_contact on public.groups;
create trigger groups_crm_record_contact after update of primary_contact, primary_contact_email on public.groups
  for each row execute function public.crm_record_contact_sync();

-- Internal only: user emails / phones must never be readable through the API roles.
revoke all on public.crm_expected_user_contacts, public.crm_expected_record_contacts from public, anon, authenticated;
revoke all on function public.crm_contacts_reconcile(boolean) from public, anon, authenticated;
revoke all on function public.crm_sync_user_contact(uuid, boolean, boolean) from public, anon, authenticated;
revoke all on function public.crm_sync_record_contact(uuid, boolean) from public, anon, authenticated;
revoke all on function public.crm_merge_contact(uuid, uuid) from public, anon, authenticated;
revoke all on function public.crm_split_name(text), public.crm_user_role_tag(text), public.crm_clean_email(text),
  public.crm_user_company_id(public.profiles) from public, anon, authenticated;
