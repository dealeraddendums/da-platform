-- 131_da_api_readonly_dealers_grant.sql
--
-- The da-api-service widget routes gained an optional ?dealer= param
-- (2026-07-17) that resolves inventory_dealer_id/dealer_id via the dealers
-- table — the first time the service's read-only role touches it. Grant is
-- column-scoped: the public API role can resolve dealer identifiers and
-- nothing else (no names, contacts, billing ids, etc.).

GRANT SELECT (dealer_id, inventory_dealer_id) ON dealers TO da_api_readonly;
