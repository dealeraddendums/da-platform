-- Allow reseller / service-group API keys in key_owners (da-api-service key-gated
-- routes). Some legacy KeyOwner rows are NOT bound to a single dealer — e.g. Dealer
-- General, a service group that prints/manages many dealerships and drives ~73k
-- /search calls, scoping per-request (its callers pass a legacy dealership_id, or
-- just a globally-unique VIN). The original table (migration 120) made dealer_id
-- NOT NULL + FK, so such a key cannot be represented at all and fails closed,
-- which blocks decommissioning the legacy API Portal.
--
-- Fix: make dealer_id NULLABLE. A NULL dealer_id = "reseller key, not scoped to one
-- dealer" — da-api-service resolves those requests by VIN alone (see the /search
-- patch in da-api-service src/routes/dataapi.js). The FK is retained (a NULL value
-- is exempt from the reference), so any non-null value must still be a real dealer.
ALTER TABLE public.key_owners ALTER COLUMN dealer_id DROP NOT NULL;

COMMENT ON COLUMN public.key_owners.dealer_id IS
  'Supabase dealers.dealer_id this key is scoped to. NULL = reseller/service-group key (e.g. Dealer General) not bound to a single dealer; da-api-service resolves such requests by unique VIN, ignoring any caller-supplied dealership_id.';
