-- 185 — apply_migrated_resync: one-transaction writer for the Migration Console
-- "Re-sync from 4.0…" action on MIGRATED dealers (2026-10-22).
--
-- The ETL box computes the plan from Aurora (read-only) and calls this with
-- the explicit rows to write. Everything below runs in ONE transaction: if any
-- statement fails, nothing is written. The function repeats every safety
-- guard itself, so a stale or hand-built payload can't widen the blast radius:
--
--   * dealer must be migration_status = 'migrated' and not 5.0-native
--   * print status: only unprinted -> printed, only this dealer's vehicles, and
--     a 5.0 Clear Print History wins unless 4.0's print is on a LATER day
--   * products: only addendum_data rows 4.0 owns (legacy_id NOT NULL) under
--     this dealer's keys; 5.0-written rows (legacy_id NULL) are never touched;
--     inserts only onto this dealer's own vehicles, never a duplicate legacy_id
--   * prices: only fills msrp / internet_price that 5.0 has as NULL/0/blank,
--     on this dealer's active vehicles — never overwrites an existing price
--
-- Logs a migration_log 'resynced' row and, when the dealer has a DA-CRM
-- company, a status_change activity on its timeline. Service role only.

create or replace function public.apply_migrated_resync(
  p_dealer      uuid,
  p_actor       uuid,
  p_parts       text[],
  p_print       jsonb,
  p_inserts     jsonb,
  p_updates     jsonb,
  p_delete_ids  uuid[],
  p_prices      jsonb,
  p_preview     jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d           record;
  v_keys      text[];
  n_print     int := 0;
  n_insert    int := 0;
  n_update    int := 0;
  n_delete    int := 0;
  n_msrp      int := 0;
  n_internet  int := 0;
  v_result    jsonb;
  v_company   uuid;
  v_actor     text;
begin
  select id, dealer_id, inventory_dealer_id, name, migration_status, coalesce(is_native, false) as is_native
    into d from dealers where id = p_dealer for update;
  if not found then raise exception 'dealer % not found', p_dealer; end if;
  if d.migration_status is distinct from 'migrated' then
    raise exception 're-sync is only for migrated dealers (% is %)', d.name, coalesce(d.migration_status, 'null');
  end if;
  if d.is_native then raise exception '% is 5.0-native — nothing to re-sync', d.name; end if;
  v_keys := array_remove(array[d.dealer_id, trim(coalesce(d.inventory_dealer_id, d.dealer_id))], null);

  if 'print_status' = any(p_parts) then
    update dealer_vehicles dv set
      print_status = 1,
      print_date   = r.print_date,
      print_guide  = coalesce(r.print_guide, 0),
      print_info   = coalesce(r.print_info, 0),
      print_user   = r.print_user,
      print_flag   = coalesce(r.print_flag, 0),
      print_sms    = coalesce(r.print_sms, 0)
    from jsonb_to_recordset(coalesce(p_print, '[]'::jsonb)) as r(
      vehicle_id uuid, print_date date, print_guide smallint, print_info smallint,
      print_user text, print_flag smallint, print_sms smallint)
    where dv.id = r.vehicle_id
      and dv.dealer_id = d.dealer_id
      and coalesce(dv.print_status, 0) = 0
      and (dv.print_cleared_at is null
           or (r.print_date is not null and dv.print_cleared_at < r.print_date::timestamptz));
    get diagnostics n_print = row_count;
  end if;

  if 'products' = any(p_parts) then
    delete from addendum_data a
     where a.id = any(coalesce(p_delete_ids, '{}'))
       and a.legacy_id is not null
       and a.legacy_dealer_id = any(v_keys);
    get diagnostics n_delete = row_count;

    update addendum_data a set
      item_name  = case when u.patch ? 'item_name'  then u.patch->>'item_name'  else a.item_name end,
      item_price = case when u.patch ? 'item_price' then u.patch->>'item_price' else a.item_price end,
      active     = case when u.patch ? 'active'     then u.patch->>'active'     else a.active end
    from jsonb_to_recordset(coalesce(p_updates, '[]'::jsonb)) as u(id uuid, patch jsonb)
    where a.id = u.id
      and a.legacy_id is not null
      and a.legacy_dealer_id = any(v_keys);
    get diagnostics n_update = row_count;

    insert into addendum_data (dealer_id, legacy_dealer_id, legacy_id, legacy_vehicle_id, vehicle_id,
      item_name, item_description, item_price, active, separator_above, separator_below, separator_spaces,
      order_by, editable, vin_number, or_or_ad, document_type, created_at, updated_at)
    select d.id, d.dealer_id, r.legacy_id, r.legacy_vehicle_id, r.vehicle_id,
      r.item_name, r.item_description, r.item_price, r.active, r.separator_above, r.separator_below, r.separator_spaces,
      r.order_by, r.editable, r.vin_number, r.or_or_ad, 'addendum', r.created_at, r.updated_at
    from jsonb_to_recordset(coalesce(p_inserts, '[]'::jsonb)) as r(
      legacy_id int, legacy_vehicle_id int, vehicle_id uuid, item_name text, item_description text,
      item_price text, active text, separator_above smallint, separator_below smallint, separator_spaces int,
      order_by int, editable int, vin_number text, or_or_ad smallint, created_at timestamptz, updated_at timestamptz)
    where r.legacy_id is not null
      and exists (select 1 from dealer_vehicles dv where dv.id = r.vehicle_id and dv.dealer_id = d.dealer_id)
    on conflict (legacy_id) where legacy_id is not null do nothing;
    get diagnostics n_insert = row_count;
  end if;

  if 'missing_prices' = any(p_parts) then
    update dealer_vehicles dv set msrp = r.msrp
    from jsonb_to_recordset(coalesce(p_prices, '[]'::jsonb)) as r(vehicle_id uuid, msrp numeric, internet_price numeric)
    where dv.id = r.vehicle_id and dv.dealer_id = d.dealer_id and dv.status = 'active'
      and r.msrp > 0 and r.msrp <= 10000000
      and coalesce(dv.msrp, 0) <= 0;
    get diagnostics n_msrp = row_count;

    update dealer_vehicles dv set internet_price = r.internet_price::text
    from jsonb_to_recordset(coalesce(p_prices, '[]'::jsonb)) as r(vehicle_id uuid, msrp numeric, internet_price numeric)
    where dv.id = r.vehicle_id and dv.dealer_id = d.dealer_id and dv.status = 'active'
      and r.internet_price > 0 and r.internet_price <= 10000000
      and coalesce(nullif(regexp_replace(coalesce(dv.internet_price, ''), '[^0-9.]', '', 'g'), '')::numeric, 0) <= 0;
    get diagnostics n_internet = row_count;
  end if;

  v_result := jsonb_build_object(
    'print_status_marked', n_print,
    'products_added', n_insert, 'products_removed', n_delete, 'products_changed', n_update,
    'msrp_filled', n_msrp, 'internet_price_filled', n_internet);

  select email into v_actor from profiles where id = p_actor;

  insert into migration_log (dealer_id, event, performed_by, notes)
  values (d.id, 'resynced', p_actor,
    format('Re-sync from 4.0 (migrated dealer) by %s — parts: %s. Applied: %s. Previewed: %s',
      coalesce(v_actor, p_actor::text), array_to_string(p_parts, ', '), v_result::text, coalesce(p_preview, '{}'::jsonb)::text));

  select id into v_company from crm_companies where dealer_id = d.id;
  if v_company is not null then
    insert into crm_activities (company_id, type, direction, subject, body, metadata, occurred_at)
    values (v_company, 'status_change', 'internal',
      'Re-sync from 4.0: ' || array_to_string(p_parts, ', '),
      format('Run by %s. %s', coalesce(v_actor, p_actor::text), v_result::text),
      jsonb_build_object('source', 'migration_resync', 'parts', to_jsonb(p_parts), 'applied', v_result,
                         'previewed', p_preview, 'performed_by', p_actor),
      now());
  end if;

  return v_result;
end;
$$;

revoke all on function public.apply_migrated_resync(uuid, uuid, text[], jsonb, jsonb, jsonb, uuid[], jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.apply_migrated_resync(uuid, uuid, text[], jsonb, jsonb, jsonb, uuid[], jsonb, jsonb) to service_role;
