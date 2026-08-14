-- 143 — HubSpot Contact id for the dealer's PRIMARY CONTACT (2026-08-14)
--
-- Dealer creation/edit now upserts a HubSpot Contact for the primary
-- contact (name+email on the dealer record) and associates it to the
-- dealer's Company — previously Contacts were only minted at
-- /api/invite/accept, so an uninvited primary contact never existed in the
-- CRM (Mercedes-Benz of Westmont / Scott Kroft gap). The id stored here is
-- informational + dedup-hinting; matching is ALWAYS by email (contacts are
-- shared across a group's dealers — AutoNation — and PATCH-by-stored-id
-- would rename the shared Contact when a dealer swaps contact people).
ALTER TABLE public.dealers
  ADD COLUMN IF NOT EXISTS hubspot_primary_contact_id text NULL;
