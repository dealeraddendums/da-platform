-- 184_crm_feed_order_dealerships.sql — DA-CRM Phase 2b: one feed request for
-- several dealerships (a group's rooftops), and the Autosoft activation reply.
--
-- crm_feed_orders becomes parent / child:
--   parent (parent_order_id null) — ONE per request: the thread, approver,
--     supplier, request-level supplier answers, the PDF(s), and the status up
--     to feed_id_received. dealer_company_id = the company it was started
--     from (a dealer, or a group for several rooftops).
--   child (parent_order_id set) — ONE per dealership: its own Feed ID
--     (feed_id_candidate / feed_id_confirmed / assigned_at), its per-rooftop
--     answers (Autosoft account), its request / signed PDF when the supplier
--     takes one form per rooftop. Status: pending → feed_id_received →
--     assigned → done (or cancelled); each child confirms independently.
--   The parent goes done once every child is assigned (or done) or cancelled.
-- Every order has at least one child, a single-dealer order exactly one.
-- Depends on 182 / 183.

-- ── Parent / child ───────────────────────────────────────────────────────────
alter table public.crm_feed_orders
  add column if not exists parent_order_id uuid references public.crm_feed_orders(id) on delete cascade,
  -- PDF suppliers, several rooftops: one form per rooftop (all attached to one email), or one form for all.
  add column if not exists pdf_mode text not null default 'per_dealership' check (pdf_mode in ('per_dealership','combined'));
create index if not exists crm_feed_orders_parent_idx on public.crm_feed_orders (parent_order_id) where parent_order_id is not null;

alter table public.crm_feed_orders drop constraint if exists crm_feed_orders_status_check;
alter table public.crm_feed_orders add constraint crm_feed_orders_status_check check (status in (
  'needs_info','ready','request_sent','awaiting_dealer_approval','awaiting_supplier',
  'pending','feed_id_received','assigned','done','cancelled'));
-- 'pending' is a child's status only (waiting for its Feed ID); a parent never stores it.
alter table public.crm_feed_orders drop constraint if exists crm_feed_orders_pending_child;
alter table public.crm_feed_orders add constraint crm_feed_orders_pending_child check (status <> 'pending' or parent_order_id is not null);

-- Parents may be started from a group; children are always dealers (checked in lib/crm/feeds/orders.ts).
-- One open order per DEALERSHIP: the unique index moves from the order to its children.
drop index if exists public.crm_feed_orders_one_open;
create unique index if not exists crm_feed_orders_one_open_dealership
  on public.crm_feed_orders (dealer_company_id) where parent_order_id is not null and status not in ('done','cancelled');

-- ── Sender ("on behalf of") ──────────────────────────────────────────────────
-- Graph's `sender` when it differs from `from`: Autosoft's replies go out through
-- Salesforce (noreply@salesforce.com) on behalf of dcsconnect@autosoftdms.com.
alter table public.crm_emails add column if not exists sender_email text;
