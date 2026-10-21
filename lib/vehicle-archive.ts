/**
 * Archive one inactive vehicle (used by POST /api/cron/archive-vehicles).
 *
 * Order matters: deleting from dealer_vehicles cascades vehicle_audit_log, so
 * the vehicle row AND its whole audit trail must be safely copied into the
 * archive tables first. Any failure before the delete skips the vehicle (it
 * stays in dealer_vehicles, the next run retries) — never delete without the
 * copy.
 *
 * Idempotent: a vehicle already in dealer_vehicles_archive (an earlier run
 * died between copy and delete) skips the row insert, but its audit trail is
 * still re-copied and verified before the delete.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { DealerVehicleArchiveInsert, DealerVehicleRow, VehicleAuditLogArchiveInsert, VehicleAuditLogRow } from "./db";

export type ArchiveOutcome =
  | { status: "archived"; auditRows: number }
  | { status: "skipped"; reason: string };

export async function archiveVehicle(admin: any, vehicle: DealerVehicleRow, now: string): Promise<ArchiveOutcome> {
  const skip = (reason: string): ArchiveOutcome => ({ status: "skipped", reason });

  // 1. Audit trail, read BEFORE the delete cascades it.
  const { data: auditEntries, error: auditReadErr } = await admin
    .from("vehicle_audit_log")
    .select("*")
    .eq("vehicle_id", vehicle.id)
    .order("created_at", { ascending: true });
  if (auditReadErr) return skip(`audit read: ${auditReadErr.message}`);
  const entries = (auditEntries ?? []) as VehicleAuditLogRow[];

  // 2. Vehicle row (once).
  const { data: alreadyArchived, error: lookupErr } = await admin
    .from("dealer_vehicles_archive")
    .select("id")
    .eq("id", vehicle.id)
    .maybeSingle();
  if (lookupErr) return skip(`archive lookup: ${lookupErr.message}`);
  if (!alreadyArchived) {
    const archiveRow: DealerVehicleArchiveInsert = { ...vehicle, archived_at: now, archive_reason: "cron_6month_inactive" };
    const { error: archiveErr } = await admin.from("dealer_vehicles_archive").insert(archiveRow);
    if (archiveErr) return skip(`archive insert: ${archiveErr.message}`);
  }

  // 3. Audit trail copy (original ids → re-runs are no-ops), then verify every row landed.
  if (entries.length) {
    const rows: VehicleAuditLogArchiveInsert[] = entries.map((e) => ({
      id: e.id,
      dealer_id: e.dealer_id,
      vehicle_id: e.vehicle_id,
      stock_number: e.stock_number,
      action: e.action,
      method: e.method,
      changed_by: e.changed_by,
      changed_by_email: e.changed_by_email,
      changes: e.changes as Record<string, { old: unknown; new: unknown }> | null,
      document_type: e.document_type,
      created_at: e.created_at,
    }));
    const { error: copyErr } = await admin
      .from("vehicle_audit_log_archive")
      .upsert(rows, { onConflict: "id", ignoreDuplicates: true });
    if (copyErr) return skip(`audit copy: ${copyErr.message}`);

    const { count, error: verifyErr } = await admin
      .from("vehicle_audit_log_archive")
      .select("id", { count: "exact", head: true })
      .in("id", rows.map((r) => r.id));
    if (verifyErr) return skip(`audit verify: ${verifyErr.message}`);
    if ((count ?? 0) < rows.length) return skip(`audit verify: ${count ?? 0} of ${rows.length} rows in the archive`);
  }

  // 4. The archive event itself — informational; a failure doesn't block the delete.
  const event: VehicleAuditLogArchiveInsert = {
    dealer_id: vehicle.dealer_id,
    vehicle_id: vehicle.id,
    stock_number: vehicle.stock_number,
    action: "archived",
    method: "cron",
  };
  const { error: eventErr } = await admin.from("vehicle_audit_log_archive").insert(event);
  if (eventErr) console.error(`[archive-vehicles] archive event log failed for ${vehicle.id}:`, eventErr.message);

  // 5. Only now delete (cascades vehicle_audit_log).
  const { error: deleteErr } = await admin.from("dealer_vehicles").delete().eq("id", vehicle.id);
  if (deleteErr) return skip(`delete: ${deleteErr.message}`);

  return { status: "archived", auditRows: entries.length };
}
