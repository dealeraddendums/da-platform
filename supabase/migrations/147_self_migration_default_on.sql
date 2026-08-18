-- 147 — Self-service group migration becomes DEFAULT-ON (2026-08-18, Allan).
--
-- groups.self_manages_migration flips from an opt-IN toggle to a force-OFF
-- kill switch: availability now DERIVES from "group is migrated + group-billed
-- on DA-Billing" (billing_customer_id present AND its da-billing customer is
-- Live, i.e. billingState != 'setup'). The flag only matters when explicitly
-- set false — a group Allan wants to hold back.
--
-- Apply via Supabase SQL editor (Dashboard -> SQL editor -> Run).

ALTER TABLE groups ALTER COLUMN self_manages_migration SET DEFAULT true;
UPDATE groups SET self_manages_migration = true WHERE self_manages_migration = false;

COMMENT ON COLUMN groups.self_manages_migration IS
  'Kill switch (super_admin; default true): set FALSE to hide the group self-service migrate UI for a specific group. Availability otherwise derives from migrated + group-billed (live da-billing group customer) in /api/groups/[id]/self-migrate.';
