import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import type {
  DealerVehicleRow,
  DealerVehicleArchiveInsert,
  VehicleAuditLogRow,
  VehicleAuditLogArchiveInsert,
} from "@/lib/db";

const BATCH_SIZE = 500;

/**
 * POST /api/cron/archive-vehicles
 * Protected by x-cron-secret header.
 * Finds dealer_vehicles WHERE status='inactive' AND updated_at < 6 months ago,
 * copies them to dealer_vehicles_archive, preserves their audit trail in
 * vehicle_audit_log_archive, then hard-deletes from dealer_vehicles.
 *
 * Idempotent: vehicles already in archive are skipped; only the DELETE is retried.
 * Schedule: 0 3 * * 0 (3 AM UTC every Sunday)
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminSupabaseClient();

  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const cutoff = sixMonthsAgo.toISOString();

  let archived = 0;
  const errors: Array<{ id: string; error: string }> = [];

  // Fetch one batch at a time (max BATCH_SIZE)
  const { data: vehicles, error: fetchErr } = await admin
    .from("dealer_vehicles")
    .select("*")
    .eq("status", "inactive")
    .lt("updated_at", cutoff)
    .limit(BATCH_SIZE);

  if (fetchErr) {
    console.error("[archive-vehicles] fetch error:", fetchErr.message);
    return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  }

  if (!vehicles || vehicles.length === 0) {
    return NextResponse.json({ archived: 0, errors: [], message: "No vehicles to archive" });
  }

  const now = new Date().toISOString();

  for (const vehicle of vehicles as DealerVehicleRow[]) {
    try {
      // Check idempotency — skip archive step if vehicle was already copied
      // (handles partial failure where archive succeeded but delete failed)
      const { data: alreadyArchived } = await admin
        .from("dealer_vehicles_archive")
        .select("id")
        .eq("id", vehicle.id)
        .maybeSingle();

      if (!alreadyArchived) {
        // 1. Fetch audit trail BEFORE delete cascades it
        const { data: auditEntries } = await admin
          .from("vehicle_audit_log")
          .select("*")
          .eq("vehicle_id", vehicle.id)
          .order("created_at", { ascending: true });

        // 2. Copy vehicle to archive
        const archiveRow: DealerVehicleArchiveInsert = {
          ...(vehicle as DealerVehicleRow),
          archived_at: now,
          archive_reason: "cron_6month_inactive",
        };
        const { error: archiveErr } = await admin
          .from("dealer_vehicles_archive")
          .insert(archiveRow);
        if (archiveErr) throw new Error(`archive insert: ${archiveErr.message}`);

        // 3. Copy audit entries (preserve original ids for idempotency)
        if (auditEntries && auditEntries.length > 0) {
          const auditArchiveRows: VehicleAuditLogArchiveInsert[] = (auditEntries as VehicleAuditLogRow[]).map(
            (e) => ({
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
            })
          );
          // upsert with ignoreDuplicates so re-runs don't error on PK conflict
          const { error: auditCopyErr } = await admin
            .from("vehicle_audit_log_archive")
            .upsert(auditArchiveRows, { onConflict: "id", ignoreDuplicates: true });
          if (auditCopyErr) {
            console.error(`[archive-vehicles] audit copy failed for ${vehicle.id}:`, auditCopyErr.message);
          }
        }

        // 4. Log the archive event itself
        const archiveEventRow: VehicleAuditLogArchiveInsert = {
          dealer_id: vehicle.dealer_id,
          vehicle_id: vehicle.id,
          stock_number: vehicle.stock_number,
          action: "archived",
          method: "cron",
        };
        const { error: archiveEventErr } = await admin
          .from("vehicle_audit_log_archive")
          .insert(archiveEventRow);
        if (archiveEventErr) {
          console.error(`[archive-vehicles] archive event log failed for ${vehicle.id}:`, archiveEventErr.message);
        }
      }

      // 5. Delete from dealer_vehicles (cascades vehicle_audit_log entries)
      const { error: deleteErr } = await admin
        .from("dealer_vehicles")
        .delete()
        .eq("id", vehicle.id);
      if (deleteErr) throw new Error(`delete: ${deleteErr.message}`);

      archived++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[archive-vehicles] failed for vehicle ${vehicle.id}:`, msg);
      errors.push({ id: vehicle.id, error: msg });
    }
  }

  console.log(`[archive-vehicles] done — archived: ${archived}, errors: ${errors.length}`);
  return NextResponse.json({ archived, errors });
}
