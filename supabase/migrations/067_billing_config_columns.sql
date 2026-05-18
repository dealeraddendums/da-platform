-- Migration 067: per-dealer + per-group billing config columns (Phase 10).
--
-- billing_customer_id stores the da-billing customer UUID returned by
-- POST /api/v1/customers. For dealers migrated from legacy, internal_id
-- remains the canonical billing key; for dealers created on the new
-- platform post-Phase-10, billing_customer_id is the source of truth.
-- Code that needs to find the dealer's billing template should prefer
-- billing_customer_id and fall back to internal_id.
--
-- subscription_billed_to and labels_billed_to control which da-billing
-- template receives the line items for monthly subscription vs label
-- orders. 'dealer' (default) writes to the dealer's own template; 'group'
-- writes to the group's template. Switching to 'group' requires the
-- dealer to be in a group (enforced in app code) and the group to have
-- a billing_customer_id of its own.

ALTER TABLE public.dealers
  ADD COLUMN IF NOT EXISTS billing_customer_id text,
  ADD COLUMN IF NOT EXISTS subscription_billed_to text NOT NULL DEFAULT 'dealer'
    CHECK (subscription_billed_to IN ('dealer','group')),
  ADD COLUMN IF NOT EXISTS labels_billed_to text NOT NULL DEFAULT 'dealer'
    CHECK (labels_billed_to IN ('dealer','group'));

CREATE INDEX IF NOT EXISTS dealers_billing_customer_id_idx
  ON public.dealers (billing_customer_id);

COMMENT ON COLUMN public.dealers.billing_customer_id IS
  'da-billing customer UUID (POST /api/v1/customers). For platform-created '
  'dealers post-Phase-10; legacy migrated dealers use internal_id.';
COMMENT ON COLUMN public.dealers.subscription_billed_to IS
  '"dealer" (default) or "group". Controls which da-billing template '
  'receives the monthly subscription line item.';
COMMENT ON COLUMN public.dealers.labels_billed_to IS
  '"dealer" (default) or "group". Controls which da-billing template '
  'receives line items when this dealer orders labels.';

ALTER TABLE public.groups
  ADD COLUMN IF NOT EXISTS billing_customer_id text;

CREATE INDEX IF NOT EXISTS groups_billing_customer_id_idx
  ON public.groups (billing_customer_id);

COMMENT ON COLUMN public.groups.billing_customer_id IS
  'da-billing customer UUID for the group. Created on demand the first '
  'time a member dealer flips subscription_billed_to or labels_billed_to '
  'to "group".';
