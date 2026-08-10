-- 140 — Clear Print History: survive ETL Job 6 + fix the silent audit failure
-- (2026-08-10, Napleton Mazda of Libertyville incident)
--
-- 1. dealer_vehicles.print_cleared_at — stamped by both Clear Print History
--    actions (selected-vehicles /api/print/clear-history and the per-dealer
--    settings reset). ETL Job 6 (print status) keeps syncing 4.0 prints even
--    for etl_locked dealers, so an operator's deliberate clear on a dealer
--    still printing on 4.0 was silently re-marked the same night. Job 6 now
--    skips a vehicle unless Aurora shows a print NEWER than the clear
--    (same-day tie → the clear wins; a genuinely new 4.0 print re-marks).
ALTER TABLE public.dealer_vehicles
  ADD COLUMN IF NOT EXISTS print_cleared_at timestamptz NULL;

-- 2. vehicle_audit_log: allow 'print_history_cleared'. Both clear routes have
--    inserted it since they shipped, but migration 032's CHECK never included
--    it — every audit insert failed silently (the insert error was unchecked),
--    so the clear actions have NO audit trail to date. The lib/db.ts
--    VehicleAuditLogAction union already lists it.
ALTER TABLE public.vehicle_audit_log
  DROP CONSTRAINT IF EXISTS vehicle_audit_log_action_check;

ALTER TABLE public.vehicle_audit_log
  ADD CONSTRAINT vehicle_audit_log_action_check
  CHECK (action IN (
    'import', 'edit', 'print', 'delete',
    'archived', 'restored_from_archive',
    'print_history_cleared'
  ));
