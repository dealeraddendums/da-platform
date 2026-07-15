-- Migration 127: create the admin_audit table the code has been writing to.
--
-- lib/db.ts has typed admin_audit since the impersonation work, and 13 call
-- sites insert into it (ghost mint/exit, impersonate ×4, dealer/group DELETE,
-- inventory-dealer-id cascade, create-dealer-user, migration invites,
-- extend-trial) — but the table was never created in prod, so every one of
-- those fire-and-forget inserts has silently failed (PGRST205). Discovered
-- 2026-07-15 while verifying the extend-trial audit row.
--
-- Shape matches AdminAuditRow / AdminAuditInsert in lib/db.ts exactly.

create table if not exists admin_audit (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null,
  action text not null,
  target_dealer_id text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_action_idx on admin_audit (action, created_at desc);
create index if not exists admin_audit_admin_user_idx on admin_audit (admin_user_id, created_at desc);

-- Service-role only (all writers use the admin client). RLS on with no
-- policies = anon/authed clients can neither read nor write.
alter table admin_audit enable row level security;

comment on table admin_audit is
  'Operator action log (ghost, impersonate, deletes, trial extensions, …). Written fire-and-forget by API routes via the service-role client.';
