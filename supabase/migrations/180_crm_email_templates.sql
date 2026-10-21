-- 180_crm_email_templates.sql — DA-CRM email templates (Communications → Templates).
--
-- Replaces HubSpot email templates. crm_admin creates / edits / archives;
-- every DA-CRM user can preview and use them (compose arrives with the Phase 2
-- Inbox). Variables are {{group.field}} — see lib/crm/template-vars.ts for the
-- catalogue; `variables` caches the ones a template uses (refreshed on save).
-- Every outbound email appends the sender's crm_staff_profiles.email_signature_html
-- (lib/crm/email-compose.ts), so templates never carry a signature themselves.
-- Depends on 179 (has_staff_permission, crm_touch_updated_at).

create table if not exists public.crm_email_templates (
  id             uuid        primary key default gen_random_uuid(),
  name           text        not null,
  category       text,                     -- free text; HubSpot "folder" on import
  subject        text        not null default '',
  body_html      text        not null default '',
  variables      text[]      not null default '{}',
  source         text        not null default 'manual' check (source in ('manual','hubspot_import')),
  -- Import / validation findings: {converted:[…], approximated:[…], unmapped:[…]}.
  import_report  jsonb,
  needs_review   boolean     not null default false,   -- has tokens DA-CRM can't fill
  archived       boolean     not null default false,
  created_by     uuid        references public.profiles(id) on delete set null,
  updated_by     uuid        references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- One live template per name (case-insensitive); archived names can be reused.
create unique index if not exists crm_email_templates_name_uniq
  on public.crm_email_templates (lower(name)) where not archived;
create index if not exists crm_email_templates_category_idx
  on public.crm_email_templates (category) where not archived;

drop trigger if exists crm_email_templates_touch on public.crm_email_templates;
create trigger crm_email_templates_touch before update on public.crm_email_templates
  for each row execute function public.crm_touch_updated_at();

alter table public.crm_email_templates enable row level security;
drop policy if exists crm_email_templates_read on public.crm_email_templates;
create policy crm_email_templates_read on public.crm_email_templates
  for select using (public.has_staff_permission('crm'));
drop policy if exists crm_email_templates_admin on public.crm_email_templates;
create policy crm_email_templates_admin on public.crm_email_templates
  for all using (public.has_staff_permission('crm_admin')) with check (public.has_staff_permission('crm_admin'));
