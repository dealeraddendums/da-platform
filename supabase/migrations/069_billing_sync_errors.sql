-- Migration 069: billing_sync_errors retry log (Phase 10).
--
-- Every fire-and-forget call to da-billing or XPS that fails lands here so
-- super_admin can review and retry. The non-blocking sync wrapper
-- (lib/billing-sync.ts) writes to this table on any caught exception.
--
-- event_type is a string discriminator like:
--   "billing.customer.create"   "billing.template.upsert"
--   "billing.customer.archive"  "billing.customer.unarchive"
--   "xps.order.create"          "xps.shipment.poll"
-- payload is the JSON body that was about to be sent (sanitized — never
-- include API keys).

CREATE TABLE IF NOT EXISTS public.billing_sync_errors (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type    text        NOT NULL,
  payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  error_message text        NOT NULL,
  dealer_id     uuid        REFERENCES public.dealers(id) ON DELETE SET NULL,
  group_id      uuid        REFERENCES public.groups(id)  ON DELETE SET NULL,
  resolved      boolean     NOT NULL DEFAULT false,
  retry_count   integer     NOT NULL DEFAULT 0,
  last_retry_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_sync_errors_unresolved_idx
  ON public.billing_sync_errors (resolved, created_at DESC)
  WHERE resolved = false;
CREATE INDEX IF NOT EXISTS billing_sync_errors_event_type_idx
  ON public.billing_sync_errors (event_type);
CREATE INDEX IF NOT EXISTS billing_sync_errors_dealer_id_idx
  ON public.billing_sync_errors (dealer_id);

ALTER TABLE public.billing_sync_errors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "billing_sync_errors_super_admin"
  ON public.billing_sync_errors FOR ALL
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'super_admin');
