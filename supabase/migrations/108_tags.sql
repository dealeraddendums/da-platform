-- 108_tags.sql — Dealer & Group Tagging v1
--
-- One shared tag namespace assignable to BOTH dealers and groups (a single
-- "AutoNation" tag). Normalized store (tags + join tables) — not a text[] —
-- so the picker reuses one canonical tag, counts are accurate, and a future
-- rename touches one row. See docs/dealer-group-tagging.md.
--
-- RLS: all three tables are SELECT-able by any authenticated user; there are
-- no INSERT/UPDATE/DELETE policies, so writes are blocked for normal sessions
-- and go exclusively through the role-gated API (admin/service-role client,
-- which bypasses RLS) — consistent with the platform's other write paths.

-- ── tags ──────────────────────────────────────────────────────────────────────
create table if not exists public.tags (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  color       text,
  created_by  uuid,
  created_at  timestamptz not null default now()
);

-- Case-insensitive uniqueness — one "AutoNation" no matter how it's typed.
create unique index if not exists tags_lower_name_uniq on public.tags (lower(name));

-- ── dealer_tags ─────────────────────────────────────────────────────────────
create table if not exists public.dealer_tags (
  dealer_id   uuid not null references public.dealers(id) on delete cascade,
  tag_id      uuid not null references public.tags(id)    on delete cascade,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  primary key (dealer_id, tag_id)          -- == UNIQUE(dealer_id, tag_id)
);
create index if not exists dealer_tags_tag_id_idx    on public.dealer_tags (tag_id);
create index if not exists dealer_tags_dealer_id_idx on public.dealer_tags (dealer_id);

-- ── group_tags ──────────────────────────────────────────────────────────────
create table if not exists public.group_tags (
  group_id    uuid not null references public.groups(id) on delete cascade,
  tag_id      uuid not null references public.tags(id)   on delete cascade,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  primary key (group_id, tag_id)           -- == UNIQUE(group_id, tag_id)
);
create index if not exists group_tags_tag_id_idx   on public.group_tags (tag_id);
create index if not exists group_tags_group_id_idx on public.group_tags (group_id);

-- ── RLS: read for any authenticated user; writes blocked (API-only) ──────────
alter table public.tags        enable row level security;
alter table public.dealer_tags enable row level security;
alter table public.group_tags  enable row level security;

create policy "tags_read"        on public.tags        for select using (auth.uid() is not null);
create policy "dealer_tags_read" on public.dealer_tags for select using (auth.uid() is not null);
create policy "group_tags_read"  on public.group_tags  for select using (auth.uid() is not null);
