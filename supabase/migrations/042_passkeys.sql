-- 042_passkeys.sql
-- Stores WebAuthn passkey credentials per user
create table passkeys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  credential_id text unique not null,
  credential_public_key text not null,
  counter bigint not null default 0,
  device_type text,
  backed_up boolean default false,
  transports text[],
  friendly_name text default 'My Passkey',
  created_at timestamptz default now(),
  last_used_at timestamptz
);

alter table passkeys enable row level security;

create policy "users_own_passkeys" on passkeys
  for all using (user_id = auth.uid());

create policy "service_role_all_passkeys" on passkeys
  for all to service_role using (true);

-- Short-lived challenge storage for WebAuthn flows (5-min TTL)
create table passkey_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  challenge text not null,
  created_at timestamptz default now(),
  expires_at timestamptz default now() + interval '5 minutes'
);

alter table passkey_challenges enable row level security;

create policy "service_role_challenges" on passkey_challenges
  for all to service_role using (true);
