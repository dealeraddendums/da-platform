-- DA-CRM company page (three-column rebuild).
--   1. Owner auto-clear: a dealer that converts to a billing state (pipeline
--      stage 'paying' — shown as Current / Past Due / Suspended from DA-Billing)
--      has no owner. Enforced here so every path (UI, API, scripts) obeys it.
--      Feed-order owners live on crm_feed_orders and are unaffected.
--   2. AI summary cache on the company + a generation log for spend.
--   3. Tickets get a description and a priority (the Tasks & Tickets card).

-- ── 1. Owner auto-clear ─────────────────────────────────────────────────────
create or replace function public.crm_guard_owner_change()
returns trigger language plpgsql as $$
begin
  if new.owner_staff_id is distinct from old.owner_staff_id
     and auth.uid() is not null
     and not public.has_staff_permission('crm_admin') then
    raise exception 'Changing a company owner requires crm_admin';
  end if;
  if new.pipeline_stage is distinct from old.pipeline_stage then
    new.stage_changed_at := now();
  end if;
  -- Owners are for Trial / Setup & training only: converting clears it, and a
  -- paying dealer can't be given one. (After the guard above, so a non-admin
  -- converting a dealer isn't refused for the owner change it implies.)
  if new.pipeline_stage = 'paying' then
    new.owner_staff_id := null;
  end if;
  return new;
end;
$$;

update public.crm_companies set owner_staff_id = null
 where pipeline_stage = 'paying' and owner_staff_id is not null;

-- ── 2. AI summary ───────────────────────────────────────────────────────────
-- ai_summary: { sentences: [{ text, sources: [ref…] }], next_step: { text, sources },
--               refs: { ref: { kind, id, label, at } } } (lib/crm/company-summary.ts)
-- ai_summary_hwm: newest activity / ticket / task change the summary covers.
-- ai_summary_started_at: in-flight claim, so two viewers don't both generate.
alter table public.crm_companies
  add column if not exists ai_summary              jsonb,
  add column if not exists ai_summary_generated_at timestamptz,
  add column if not exists ai_summary_hwm          timestamptz,
  add column if not exists ai_summary_started_at   timestamptz;

create table if not exists public.crm_ai_generations (
  id             uuid        primary key default gen_random_uuid(),
  company_id     uuid        references public.crm_companies(id) on delete cascade,
  purpose        text        not null default 'company_summary',
  trigger        text        not null check (trigger in ('auto','manual')),
  staff_id       uuid        references public.profiles(id) on delete set null,
  model          text        not null,
  input_tokens   integer,
  output_tokens  integer,
  cost_usd       numeric(10,5),
  items          integer,     -- source items sent
  error          text,
  created_at     timestamptz not null default now()
);
create index if not exists crm_ai_generations_created_idx on public.crm_ai_generations (created_at desc);
create index if not exists crm_ai_generations_company_idx on public.crm_ai_generations (company_id, created_at desc);
alter table public.crm_ai_generations enable row level security;
-- Service role only (the API checks DA-CRM access); no policies on purpose.

-- ── 3. Tickets ──────────────────────────────────────────────────────────────
alter table public.crm_tickets
  add column if not exists description text,
  add column if not exists priority    text not null default 'normal'
    check (priority in ('low','normal','high','urgent')),
  add column if not exists created_by  uuid references public.profiles(id) on delete set null,
  add column if not exists resolved_at timestamptz;
