-- Migration 035: addendum_data table
-- Mirrors Aurora addendum_data structure, adds Supabase UUID relationships.
-- Used as a print-time snapshot of every option on every document.

create table if not exists public.addendum_data (
  id                uuid primary key default gen_random_uuid(),
  dealer_id         uuid not null references public.dealers(id) on delete cascade,
  legacy_dealer_id  text,                        -- Aurora DEALER_ID, for import matching
  vehicle_id        uuid references public.dealer_vehicles(id) on delete set null,
  legacy_vehicle_id int,                         -- Aurora VEHICLE_ID, for import matching
  item_name         text not null,
  item_description  text,
  item_price        varchar(20),
  active            varchar(3) default '1',
  separator_below   smallint default 0,
  separator_above   smallint default 0,
  or_or_ad          smallint default 1,          -- 1=addendum, 2=options
  vin_number        varchar(23),
  order_by          int default 0,
  separator_spaces  int default 2,
  editable          int default 1,
  printed_at        timestamptz,
  document_type     text default 'addendum',
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create index if not exists addendum_data_dealer_id_idx on public.addendum_data(dealer_id);
create index if not exists addendum_data_vehicle_id_idx on public.addendum_data(vehicle_id);
create index if not exists addendum_data_vin_number_idx on public.addendum_data(vin_number);
create index if not exists addendum_data_legacy_dealer_id_idx on public.addendum_data(legacy_dealer_id);

alter table public.addendum_data enable row level security;

create policy "super_admin full access on addendum_data"
  on public.addendum_data for all
  using ((select role from public.profiles where id = auth.uid()) = 'super_admin');

create policy "dealer read own addendum_data"
  on public.addendum_data for select
  using (
    dealer_id = (
      select d.id from public.dealers d
      join public.profiles p on p.dealer_id = d.dealer_id
      where p.id = auth.uid()
    )
  );

create policy "dealer insert own addendum_data"
  on public.addendum_data for insert
  with check (
    dealer_id = (
      select d.id from public.dealers d
      join public.profiles p on p.dealer_id = d.dealer_id
      where p.id = auth.uid()
    )
  );
