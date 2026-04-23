-- Migration 029: drop hubspot_url from dealers table.
-- HubSpot company links are now constructed at query time from Aurora dealer_dim.HUBSPOT_COMPANY_ID.

ALTER TABLE public.dealers
  DROP COLUMN IF EXISTS hubspot_url;
