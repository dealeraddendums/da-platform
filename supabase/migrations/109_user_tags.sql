-- 109_user_tags.sql — Regional Manager (group_user) tag scope, Phase 1
--
-- A group_user (regional manager) is scoped to their group ∩ their assigned
-- tags. user_tags assigns tags to a user; getJwtClaims resolves these into
-- claims.scope_tag_ids and authorizeDealerAction grants dealer-level control
-- only on in-group dealers carrying one of those tags.
-- See docs/group-user-regional-manager.md.
--
-- RLS: SELECT for any authenticated user; no INSERT/UPDATE/DELETE policies, so
-- writes are blocked for normal sessions and go through the role-gated API
-- (admin/service-role client, which bypasses RLS) — same pattern as the tags
-- tables (migration 108).

create table if not exists public.user_tags (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  tag_id      uuid not null references public.tags(id)     on delete cascade,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  primary key (user_id, tag_id)            -- == UNIQUE(user_id, tag_id)
);
create index if not exists user_tags_user_id_idx on public.user_tags (user_id);
create index if not exists user_tags_tag_id_idx  on public.user_tags (tag_id);

alter table public.user_tags enable row level security;
create policy "user_tags_read" on public.user_tags for select using (auth.uid() is not null);
