-- 191_crm_billing_status.sql — DA-CRM's copy of DA-Billing's customer status.
--
-- DA-Billing is the source of truth (GET /customers/:id/status, POST /customers/statuses — its own rules:
-- past_due = an unpaid invoice older than invoice date + that customer's Overdue Days, i.e. exactly the
-- print lock). One row per DA-Billing customer, written by:
--   poll   lib/crm/billing-status.ts when a row is missing or older than 15 minutes (batch endpoint)
--   event  POST /api/crm/events type billing.status_changed (DA-Billing posts it when a status flips)
--   sweep  npm run crm:billing-refresh (every customer at once)
-- /api/billing-cache/invalidate (DA-Billing → platform on any billing change) marks the row stale.
-- Group-billed dealers read their group's customer row. The CRM never derives a status itself.
create table if not exists public.crm_billing_status (
  customer_id uuid primary key,
  status text not null check (status in ('current', 'past_due', 'suspended', 'archived')),
  detail jsonb not null default '{}'::jsonb,    -- DA-Billing's payload: open_invoices, unpaid_balance, next_due_date, …
  fetched_at timestamptz not null default now(),
  source text not null default 'poll' check (source in ('poll', 'event', 'sweep'))
);
alter table public.crm_billing_status enable row level security;
revoke all on public.crm_billing_status from anon, authenticated;
