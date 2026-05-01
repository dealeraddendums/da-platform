-- 043_staff_profiles.sql
create table staff_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade unique not null,
  full_name text,
  title text,
  phone text,
  mobile text,
  sms_enabled boolean default true,
  avatar_url text,
  timezone text default 'America/Los_Angeles',
  on_call boolean default false,
  on_call_start time,
  on_call_end time,
  on_call_days text[],
  notification_email text,
  notification_sms text,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table staff_profiles enable row level security;

create policy "own_staff_profile" on staff_profiles
  for all using (user_id = auth.uid());

create policy "super_admin_all_staff_profiles" on staff_profiles
  for all using (
    exists (select 1 from profiles where id = auth.uid() and role = 'super_admin')
  );
