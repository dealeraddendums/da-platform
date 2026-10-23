-- 198_crm_feed_order_approver_contact.sql — the feed-order approver is a CRM contact.
--
-- Start feed order picks the approver from the dealer's (and its group's) contacts, or saves a typed-in
-- approver as a new contact of the dealer (source 'feed_order', role_tag 'approver'), deduped on email
-- at that company (lib/crm/feeds/approver.ts). The order links it; the contact gets approver_at so the
-- next order lists them first, with an "Approver" tag on contact cards.

alter table public.crm_feed_orders
  add column if not exists approver_contact_id uuid references public.crm_contacts(id) on delete set null;
create index if not exists crm_feed_orders_approver_contact_idx on public.crm_feed_orders (approver_contact_id) where approver_contact_id is not null;

-- Last time this contact was a feed-order approver (null = never).
alter table public.crm_contacts add column if not exists approver_at timestamptz;

alter table public.crm_contacts drop constraint if exists crm_contacts_role_tag_check;
alter table public.crm_contacts add constraint crm_contacts_role_tag_check
  check (role_tag is null or role_tag in ('decision_maker', 'fi', 'gm', 'admin', 'other', 'approver'));
