-- 196_crm_signature_template.sql — DA-CRM company email signature (lib/crm/signature.ts).
--
-- One template for the whole team (crm_admin, Team → Signature) replaces per-person free-form signatures.
-- composeEmail() fills it with the sender's name / title / phone (staff_profiles, edited on the staff
-- profile) and the active CTA line. Until signature_published_at is set, the per-person
-- crm_staff_profiles.email_signature_html stays the fallback (kept, no longer editable).
alter table public.crm_settings
  add column if not exists signature_template_html text,
  add column if not exists signature_published_at timestamptz,
  add column if not exists signature_published_by uuid,
  -- { text, url, starts_on, ends_on } — one team-wide line, shown only within its dates; empty = none.
  add column if not exists signature_cta jsonb not null default '{}'::jsonb;
