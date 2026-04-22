-- Migration 028: add hubspot_url to dealers table
-- Direct link to the HubSpot company record for this dealer.
-- Set and managed by super_admin from the dealer profile page.

ALTER TABLE public.dealers
  ADD COLUMN IF NOT EXISTS hubspot_url text;
