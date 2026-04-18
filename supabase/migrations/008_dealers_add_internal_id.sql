-- Phase schema fix: split dealer_id into two distinct identifiers.
--
-- internal_id: the never-changing Unix timestamp set at account creation.
--   Used for billing matching (da-billing lineItemDescription: {_ID}::{DEALER_NAME}).
--
-- inventory_dealer_id: starts as the same Unix timestamp, then gets REPLACED
--   by the inventory supplier's assigned ID once the feed goes live.
--   Used to match Aurora rows (dealer_inventory, addendum_defaults, etc.)
--   to the correct dealer account.
--
-- The existing dealer_id column is kept intact — it is referenced widely and
-- will be migrated in a follow-up pass once all usages are verified.

ALTER TABLE public.dealers
  ADD COLUMN IF NOT EXISTS internal_id text;

COMMENT ON COLUMN public.dealers.internal_id IS
  'Never-changing billing ID (_ID / Unix timestamp set at account creation). '
  'Used by da-billing for lineItemDescription matching. Never update this value.';

ALTER TABLE public.dealers
  ADD COLUMN IF NOT EXISTS inventory_dealer_id text;

COMMENT ON COLUMN public.dealers.inventory_dealer_id IS
  'Inventory supplier-assigned ID. Starts equal to internal_id, then replaced '
  'when the feed goes live. Used for all Aurora queries (dealer_inventory, '
  'addendum_defaults, etc.). This is the value that should match Aurora DEALER_ID.';

CREATE INDEX IF NOT EXISTS dealers_internal_id_idx
  ON public.dealers (internal_id)
  WHERE internal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS dealers_inventory_dealer_id_idx
  ON public.dealers (inventory_dealer_id)
  WHERE inventory_dealer_id IS NOT NULL;
