-- 183_crm_feed_suppliers.sql — DA-CRM Phase 2b: per-supplier behaviour learned
-- from real Team Velocity / vAuto / Autosoft threads (support@, Oct 2026).
-- Seeded by scripts/crm-feeds-seed.ts (the three suppliers' settings + templates).
-- Depends on 181 (crm_email_threads) and 182 (feed suppliers / orders).

-- ── Supplier settings ────────────────────────────────────────────────────────
alter table public.crm_feed_supplier_settings
  -- Mail domains the supplier writes from, beyond its request/Cc addresses (subdomains match too:
  -- Team Velocity's case notices come from salesforce.teamvelocitymarketing.com).
  add column if not exists domains               jsonb   not null default '[]'::jsonb check (jsonb_typeof(domains) = 'array'),
  -- Questions "Start feed order" asks when this supplier is picked; answers land in crm_feed_orders.supplier_fields.
  -- [{ key, label, type: text|choice, required?, default?, help?, options?: [{ value, label, requires? }], only_with? }]
  add column if not exists extra_fields          jsonb   not null default '[]'::jsonb check (jsonb_typeof(extra_fields) = 'array'),
  -- The supplier's own approval wording (vAuto: "I approve"), accepted on top of crm_settings.feed_approval_phrases.
  add column if not exists approval_phrases      jsonb   not null default '[]'::jsonb check (jsonb_typeof(approval_phrases) = 'array'),
  -- Regexes for "we'll cancel / close this without approval" in supplier mail → immediate dealer follow-up + owner task.
  add column if not exists cancellation_patterns jsonb   not null default '[]'::jsonb check (jsonb_typeof(cancellation_patterns) = 'array'),
  -- Regex (group 1) for the supplier's case / ticket number → crm_feed_orders.metadata.case_number.
  add column if not exists case_number_pattern   text,
  -- Closed cases ignore replies (vAuto): the Supplier follow-up is a NEW email quoting the case number.
  add column if not exists followup_new_thread   boolean not null default false,
  -- Replies carry no reliable Feed ID (Autosoft, until we have samples): completion replies become an
  -- "Enter Feed ID" task instead of a regex / AI guess.
  add column if not exists feed_id_manual        boolean not null default false;

-- ── Orders ───────────────────────────────────────────────────────────────────
alter table public.crm_feed_orders
  add column if not exists approver_title   text,
  -- Answers to the supplier's extra_fields (Autosoft: autosoft_account, go_dealer, transfer_row).
  add column if not exists supplier_fields  jsonb not null default '{}'::jsonb check (jsonb_typeof(supplier_fields) = 'object'),
  -- Supplier bookkeeping: { case_number, case_numbers[], cancellation_deadline: { text, at } }.
  add column if not exists metadata         jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object');

-- ── Threads ↔ orders ─────────────────────────────────────────────────────────
-- An order's mail spans several threads: ours, the supplier's own approval thread (Team Velocity's
-- "DEALER APPROVAL REQUIRED RE: …"), case notices, a fresh vAuto follow-up. Detection looks here first.
alter table public.crm_email_threads
  add column if not exists feed_order_id uuid references public.crm_feed_orders(id) on delete set null;
create index if not exists crm_email_threads_feed_order_idx on public.crm_email_threads (feed_order_id) where feed_order_id is not null;
update public.crm_email_threads t set feed_order_id = o.id
  from public.crm_feed_orders o where o.email_thread_id = t.id and t.feed_order_id is null;

-- ── Templates: "Signed PDF to supplier" kind (Autosoft's activation request) ──
alter table public.crm_email_templates drop constraint if exists crm_email_templates_feed_kind_check;
alter table public.crm_email_templates add constraint crm_email_templates_feed_kind_check check (feed_kind is null or feed_kind in
  ('request','request_pdf','dealer_followup','supplier_followup','supplier_forward','feed_assigned'));

-- ── Approval phrases (case-insensitive, whole words, newest reply text only) ─
alter table public.crm_settings alter column feed_approval_phrases set default
  '["approved","approve","i approve","approved please proceed","ok to send","yes approved","go ahead","you have my approval"]'::jsonb;
update public.crm_settings
   set feed_approval_phrases = '["approved","approve","i approve","approved please proceed","ok to send","yes approved","go ahead","you have my approval"]'::jsonb
 where feed_approval_phrases = '["APPROVED","approve","approved","ok to send","yes approved","go ahead"]'::jsonb;
