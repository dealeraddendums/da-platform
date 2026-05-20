-- Migration 071: dealer inventory provider metadata.
--
-- inventory_provider records which inventory-feed vendor (CDK, Tekion,
-- vAuto, etc.) supplies the dealer's vehicle data, distinct from the
-- inventory_dealer_id under which the feed lands. inventory_provider_is_dms
-- is the cached flag for whether that vendor is a DMS-tier provider,
-- which the billing layer reads to decide whether the dms-setup line item
-- belongs on the dealer's template. (account_type still drives the
-- subscription tier; this flag is informational for billing scaffolding.)

ALTER TABLE public.dealers
  ADD COLUMN IF NOT EXISTS inventory_provider        text,
  ADD COLUMN IF NOT EXISTS inventory_provider_is_dms boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS dealers_inventory_provider_idx
  ON public.dealers (inventory_provider)
  WHERE inventory_provider IS NOT NULL;
