-- Migration 123: print-queue metadata for the mobile print queue
-- (da-mobile/IOS-APP-SPEC.md §7). dealer_vehicles.print_queue (smallint 0/1,
-- migration 020) is the queue flag; these columns record when/who queued so
-- the Bulk Print screen can order oldest-first and audits know the actor.
-- Applied via the Supabase SQL editor by Allan — never from the prod box.

ALTER TABLE dealer_vehicles
  ADD COLUMN IF NOT EXISTS print_queue_at timestamptz,
  ADD COLUMN IF NOT EXISTS print_queue_by uuid;

COMMENT ON COLUMN dealer_vehicles.print_queue_at IS 'When the vehicle was queued for printing (mobile Print Later); bulk-print ordering key';
COMMENT ON COLUMN dealer_vehicles.print_queue_by IS 'Profile/auth user id that queued the vehicle';

-- Partial index: queue lookups are always per-dealer over the (small) set of
-- currently-queued rows.
CREATE INDEX IF NOT EXISTS idx_dealer_vehicles_print_queue
  ON dealer_vehicles (dealer_id) WHERE print_queue = 1;
