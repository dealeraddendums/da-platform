import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerVehicleRow } from "@/lib/db";
import { archiveVehicle } from "@/lib/vehicle-archive";

const BATCH_SIZE = 500;

/**
 * POST /api/cron/archive-vehicles
 * Protected by x-cron-secret header.
 * Finds dealer_vehicles WHERE status='inactive' AND updated_at < 6 months ago,
 * copies them to dealer_vehicles_archive, preserves their audit trail in
 * vehicle_audit_log_archive, then hard-deletes from dealer_vehicles.
 *
 * A vehicle is deleted only after its row and its full audit trail are copied
 * and verified (lib/vehicle-archive.ts); any copy failure skips it and logs why.
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
    // Never deletes without a verified copy of the row and its audit trail.
    const outcome = await archiveVehicle(admin, vehicle, now);
    if (outcome.status === "archived") archived++;
    else {
      console.error(`[archive-vehicles] skipped vehicle ${vehicle.id} (kept in dealer_vehicles): ${outcome.reason}`);
      errors.push({ id: vehicle.id, error: outcome.reason });
    }
  }

  console.log(`[archive-vehicles] done — archived: ${archived}, errors: ${errors.length}`);
  return NextResponse.json({ archived, errors });
}
