-- npm run test:rls — no RLS policy loop. Every public table and view is queried as anon, as a dealer user
-- and as a super admin (real users, read-only), inside a transaction that is always rolled back. Fails on
-- any "infinite recursion" error (permission-denied / no-rows are fine). Also: a dealer user reads only
-- their own profile, and every public table has RLS enabled.
do $$
declare
  rel record; who record; fails text[] := '{}'; n int := 0; msg text; cnt int;
  dealer_user uuid; coworker uuid; staff uuid;
begin
  select p.id, q.id into dealer_user, coworker from profiles p join profiles q on q.dealer_id = p.dealer_id and q.id <> p.id
   where p.role = 'dealer_admin' and p.dealer_id is not null limit 1;
  select id into staff from profiles where role = 'super_admin' and active limit 1;

  for who in select * from (values ('anon', null::uuid), ('authenticated', dealer_user), ('authenticated', staff)) v(role, uid) loop
    for rel in select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v', 'm', 'p') order by 1 loop
      n := n + 1;
      begin
        execute format('set local role %I', who.role);
        perform set_config('request.jwt.claims', coalesce(json_build_object('sub', who.uid, 'role', who.role)::text, '{"role":"anon"}'), true);
        execute format('select count(*) from (select 1 from public.%I limit 1) x', rel.relname) into cnt;
        execute 'reset role';
      exception when others then
        msg := sqlerrm;
        execute 'reset role';
        if msg ilike '%infinite recursion%' then
          fails := array_append(fails, format('%s/%s: %s', who.role, coalesce(left(who.uid::text, 8), '-'), rel.relname));
        end if;
      end;
    end loop;
  end loop;

  -- dealer user: own profile yes, coworker no, CRM no
  begin
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims', json_build_object('sub', dealer_user, 'role', 'authenticated')::text, true);
    select count(*) into cnt from profiles where id = dealer_user;
    n := n + 1; if cnt <> 1 then fails := array_append(fails, 'dealer user cannot read own profile'); end if;
    select count(*) into cnt from profiles where id = coworker;
    n := n + 1; if cnt <> 0 then fails := array_append(fails, 'dealer user can read a coworker profile'); end if;
    select count(*) into cnt from crm_contacts;
    n := n + 1; if cnt <> 0 then fails := array_append(fails, 'dealer user can read crm_contacts'); end if;
    execute 'reset role';
  exception when others then
    execute 'reset role';
    fails := array_append(fails, 'dealer-user checks errored: ' || sqlerrm);
  end;

  -- every public table has RLS on (otherwise the anon key reads it)
  for rel in select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity loop
    fails := array_append(fails, 'RLS off: ' || rel.relname);
  end loop;
  n := n + 1;

  if array_length(fails, 1) is null then raise exception 'RLS_TEST all passed (% checks)', n;
  else raise exception 'RLS_TEST % of % failed: %', array_length(fails, 1), n, array_to_string(fails, '; '); end if;
end $$;
