-- npm run test:crm-contacts — users → contacts mapping and dedupe (migration 188), run against the real
-- database inside one transaction that is always rolled back (the final RAISE aborts it). Fixtures are
-- throwaway auth users / profiles on real companies; nothing persists.
do $$
declare
  fails text[] := '{}'; n int := 0;
  d1 uuid; d1t text; d2 uuid; d2t text; g1 uuid; g1c uuid; d1c uuid; d2c uuid;
  u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid(); u3 uuid := gen_random_uuid();
  u4 uuid := gen_random_uuid(); u5 uuid := gen_random_uuid(); u6 uuid := gen_random_uuid();
  k crm_contacts; cnt int; r text; nm record;
begin
  -- helpers as inline checks
  -- pure mapping
  select * into nm from crm_split_name('  Mary  Ann   Smith ');
  n := n + 1; if nm.first_name is distinct from 'Mary' or nm.last_name is distinct from 'Ann Smith' then fails := array_append(fails, 'split: first + rest'); end if;
  select * into nm from crm_split_name('Cher');
  n := n + 1; if nm.first_name is distinct from 'Cher' or nm.last_name is not null then fails := array_append(fails, 'split: single name'); end if;
  n := n + 1; if (select first_name from crm_split_name('   ')) is not null then fails := array_append(fails, 'split: blank'); end if;
  n := n + 1; if crm_user_role_tag('dealer_admin') <> 'admin' or crm_user_role_tag('group_admin') <> 'admin'
     or crm_user_role_tag('dealer_user') <> 'other' or crm_user_role_tag('group_user') <> 'other'
     or crm_user_role_tag('dealer_restricted') <> 'other' or crm_user_role_tag('super_admin') is not null then fails := array_append(fails, 'role_tag mapping'); end if;
  n := n + 1; if crm_clean_email(' Bob@Dealer.COM ') <> 'bob@dealer.com' or crm_clean_email('devon,hawkins@x.com') is not null
     or crm_clean_email('heather deiber') is not null then fails := array_append(fails, 'clean_email'); end if;

  -- fixtures: two dealers (with text ids) and a group, all with crm rows
  select d.id, d.dealer_id, c.id into d1, d1t, d1c from dealers d join crm_companies c on c.dealer_id = d.id where d.dealer_id is not null order by d.created_at limit 1;
  select d.id, d.dealer_id, c.id into d2, d2t, d2c from dealers d join crm_companies c on c.dealer_id = d.id where d.dealer_id is not null and d.id <> d1 order by d.created_at limit 1;
  select g.id, c.id into g1, g1c from groups g join crm_companies c on c.group_id = g.id order by g.created_at limit 1;
  insert into auth.users (id, email) values (u1, 'u1@crm-test.example'), (u2, 'u2@crm-test.example'), (u3, 'u3@crm-test.example'),
    (u4, 'u4@crm-test.example'), (u5, 'u5@crm-test.example'), (u6, 'u6@crm-test.example');
  -- auth.users inserts auto-create profiles; start from none so each case sets its own.
  delete from crm_contacts where user_id in (u1, u2, u3, u4, u5, u6);
  delete from profiles where id in (u1, u2, u3, u4, u5, u6);

  -- 1. dealer admin → dealer contact, lowercased email, E.164 phone, split name
  insert into profiles (id, email, full_name, role, dealer_id, phone, active) values (u1, 'U1@CRM-Test.example', 'Dana Ruiz', 'dealer_admin', d1t, '(801) 555-0142', true);
  select * into k from crm_contacts where user_id = u1;
  n := n + 1; if k.id is null or k.company_id <> d1c or k.email <> 'u1@crm-test.example' or k.phone <> '+18015550142'
     or k.first_name <> 'Dana' or k.last_name <> 'Ruiz' or k.role_tag <> 'admin' or k.source <> 'platform_user' or k.deleted_at is not null
     then fails := array_append(fails, 'insert: dealer admin contact'); end if;

  -- 2. email change follows; unrelated profile updates don't touch the row
  update profiles set last_activity = now() where id = u1;
  n := n + 1; if (select updated_at from crm_contacts where id = k.id) <> k.updated_at then fails := array_append(fails, 'unrelated update touched contact'); end if;
  update profiles set email = 'dana.new@crm-test.example' where id = u1;
  n := n + 1; if (select email from crm_contacts where id = k.id) <> 'dana.new@crm-test.example' then fails := array_append(fails, 'email change'); end if;

  -- 3. dealer change moves the contact (same row)
  update profiles set dealer_id = d2t where id = u1;
  n := n + 1; if (select company_id from crm_contacts where id = k.id) <> d2c or (select count(*) from crm_contacts where user_id = u1) <> 1 then fails := array_append(fails, 'dealer change moves'); end if;

  -- 4. disable → soft delete; re-enable clears
  update profiles set active = false where id = u1;
  n := n + 1; if (select deleted_at from crm_contacts where id = k.id) is null then fails := array_append(fails, 'disable soft-deletes'); end if;
  update profiles set active = true where id = u1;
  n := n + 1; if (select deleted_at from crm_contacts where id = k.id) is not null then fails := array_append(fails, 're-enable clears'); end if;

  -- 5. user collides with a dealer-record contact → one row, user_id set
  insert into crm_contacts (company_id, first_name, email, source) values (d1c, 'Pat', 'u2@crm-test.example', 'dealer_record');
  insert into profiles (id, email, full_name, role, dealer_id, active) values (u2, 'u2@crm-test.example', 'Pat Lee', 'dealer_user', d1t, true);
  select count(*) into cnt from crm_contacts where company_id = d1c and lower(email) = 'u2@crm-test.example' and deleted_at is null;
  n := n + 1; if cnt <> 1 or (select user_id from crm_contacts where company_id = d1c and lower(email) = 'u2@crm-test.example' and deleted_at is null) <> u2
     or (select role_tag from crm_contacts where user_id = u2) <> 'other' then fails := array_append(fails, 'collision: record row taken over'); end if;

  -- 6. second user with the same email at the same company → conflict, first keeps the contact
  insert into profiles (id, email, full_name, role, dealer_id, active) values (u3, 'u2@crm-test.example', 'Pat Lee (2)', 'dealer_user', d1t, true);
  n := n + 1; if exists (select 1 from crm_contacts where user_id = u3 and deleted_at is null) then fails := array_append(fails, 'duplicate user got a contact'); end if;
  n := n + 1; if crm_sync_user_contact(u3, false, false) <> 'conflict' then fails := array_append(fails, 'duplicate user reported as conflict'); end if;

  -- 7. group user → group row; super_admin and test accounts → nothing
  insert into profiles (id, email, full_name, role, group_id, dealer_id, active) values (u4, 'u4@crm-test.example', 'Gail Grp', 'group_admin', g1, d1t, true);
  n := n + 1; if (select company_id from crm_contacts where user_id = u4) is distinct from g1c then fails := array_append(fails, 'group admin → group'); end if;
  insert into profiles (id, email, full_name, role, active) values (u5, 'u5@crm-test.example', 'Staff Person', 'super_admin', true);
  insert into profiles (id, email, full_name, role, dealer_id, active, test_account) values (u6, 'u6@crm-test.example', 'Test Acct', 'dealer_admin', d1t, true, true);
  n := n + 1; if exists (select 1 from crm_contacts where user_id in (u5, u6)) then fails := array_append(fails, 'staff / test accounts skipped'); end if;

  -- 8. a CRM edit to the name sticks through reconcile (fill-blanks only); a profile name change overwrites
  update crm_contacts set first_name = 'Danielle' where user_id = u1;
  r := crm_sync_user_contact(u1, false, true);
  n := n + 1; if (select first_name from crm_contacts where user_id = u1) <> 'Danielle' or r <> 'unchanged' then fails := array_append(fails, 'reconcile keeps CRM name edit'); end if;
  update profiles set full_name = 'Dana R Ruiz' where id = u1;
  n := n + 1; if (select first_name || '|' || last_name from crm_contacts where user_id = u1) <> 'Dana|R Ruiz' then fails := array_append(fails, 'profile name change overwrites'); end if;

  -- 9. delete → soft-deleted contact kept
  delete from profiles where id = u4;
  n := n + 1; if not exists (select 1 from crm_contacts where id = (select id from crm_contacts where company_id = g1c and email = 'u4@crm-test.example') and deleted_at is not null)
     then fails := array_append(fails, 'delete soft-deletes'); end if;

  -- 10. record contacts: idempotent, never duplicate a user's email, skip the dealership's own name
  update dealers set primary_contact = 'Ray Recorder', primary_contact_email = 'RAY@crm-test.example' where id = d2;
  update dealers set primary_contact = 'Ray Recorder ', primary_contact_email = 'ray@crm-test.example ' where id = d2;
  n := n + 1; if (select count(*) from crm_contacts where company_id = d2c and lower(email) = 'ray@crm-test.example' and deleted_at is null) <> 1
     or (select source from crm_contacts where company_id = d2c and lower(email) = 'ray@crm-test.example') <> 'dealer_record' then fails := array_append(fails, 'record contact once'); end if;
  n := n + 1; if crm_sync_record_contact(d2c, false) <> 'covered' then fails := array_append(fails, 'record contact covered on rerun'); end if;
  update dealers set primary_contact_email = 'dana.new@crm-test.example' where id = d2;        -- u1's email, u1 is at d2
  n := n + 1; if (select count(*) from crm_contacts where company_id = d2c and lower(email) = 'dana.new@crm-test.example' and deleted_at is null) <> 1
     then fails := array_append(fails, 'record contact skips a user email'); end if;
  update dealers set primary_contact = name, primary_contact_email = null where id = d2;
  n := n + 1; if exists (select 1 from crm_expected_record_contacts where company_id = d2c) then fails := array_append(fails, 'dealership name is not a person'); end if;

  -- 11. merge repoints references when a user's row absorbs a manual duplicate
  insert into crm_contacts (company_id, first_name, email, source) values (d2c, 'Manual', 'merge@crm-test.example', 'manual') returning * into k;
  insert into crm_activities (company_id, contact_id, type, direction, subject, occurred_at) values (d2c, k.id, 'note', 'internal', 'crm-test merge', now());
  update profiles set email = 'merge@crm-test.example' where id = u1;
  n := n + 1; if (select contact_id from crm_activities where subject = 'crm-test merge') <> (select id from crm_contacts where user_id = u1)
     or (select deleted_at from crm_contacts where id = k.id) is null then fails := array_append(fails, 'merge repoints + retires the duplicate'); end if;

  if array_length(fails, 1) is null then raise exception 'CRM_CONTACTS_TEST all passed (% checks)', n;
  else raise exception 'CRM_CONTACTS_TEST % of % failed: %', array_length(fails, 1), n, array_to_string(fails, '; '); end if;
end $$;
