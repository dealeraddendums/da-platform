-- 170_steven_tool_calls.sql — audit trail for Steven's read-only data tools.
-- One row per tool call: who asked, which tool, whose data was read (or
-- refused). Written fire-and-forget from lib/steven-tools.ts — never on the
-- reply's critical path. Service-role only.
create table if not exists steven_tool_calls (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  user_id          uuid,
  role             text,
  conversation_id  uuid,
  tool             text not null,
  -- The dealer the session was acting as, and the dealer actually read.
  -- They differ only when a group admin/user asked about a member store.
  session_dealer_id text,
  target_dealer_id  text,
  -- 'ok' | 'denied' (scope refused) | 'error' (tool failed; chat continued)
  outcome          text not null check (outcome in ('ok','denied','error')),
  detail           text,
  duration_ms      integer
);
create index if not exists steven_tool_calls_created_idx on steven_tool_calls (created_at desc);
create index if not exists steven_tool_calls_target_idx on steven_tool_calls (target_dealer_id, created_at desc);
alter table steven_tool_calls enable row level security;
