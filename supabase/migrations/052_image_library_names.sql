-- image_library: tracks uploaded platform images with editable display names
create table if not exists image_library (
  id uuid primary key default gen_random_uuid(),
  bucket text not null,
  s3_key text not null,
  url text not null,
  display_name text not null,
  file_size integer,
  uploaded_at timestamptz default now(),
  uploaded_by uuid references auth.users(id),
  unique(bucket, s3_key)
);

alter table image_library enable row level security;

-- super_admin: full access
create policy "image_library_super_admin" on image_library
  for all
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid()
      and profiles.role = 'super_admin'
    )
  )
  with check (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid()
      and profiles.role = 'super_admin'
    )
  );

-- all authenticated users: read
create policy "image_library_read" on image_library
  for select
  using (auth.uid() is not null);
