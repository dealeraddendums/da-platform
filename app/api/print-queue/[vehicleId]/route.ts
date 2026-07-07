import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { authorizeDealerAction } from "@/lib/dealer-authz";

type Params = { params: { vehicleId: string } };

// Mobile print queue (IOS-APP-SPEC §8.2). The queue flag is the existing
// dealer_vehicles.print_queue smallint (migration 020); print_queue_at /
// print_queue_by are migration 123. No print-eligibility gate here — the
// gate stays at print time (queueing a vehicle is free).

/** Apply a queue update, tolerating the pre-migration-123 schema (retry with
 *  just the print_queue flag if the meta columns don't exist yet). */
async function applyQueueUpdate(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  vehicleId: string,
  update: { print_queue: number; print_queue_at: string | null; print_queue_by: string | null },
): Promise<string | null> {
  let { error } = await admin.from("dealer_vehicles").update(update).eq("id", vehicleId);
  if (error && /print_queue_at|print_queue_by|schema cache|does not exist/i.test(error.message)) {
    const retry = await admin
      .from("dealer_vehicles")
      .update({ print_queue: update.print_queue })
      .eq("id", vehicleId);
    error = retry.error;
  }
  return error ? error.message : null;
}

/**
 * POST /api/print-queue/[vehicleId]
 * Queue a vehicle for printing (mobile "Print Later"). vehicleId is the
 * dealer_vehicles UUID. Sets print_queue=1, print_queue_at=now(),
 * print_queue_by=caller.
 */
export async function POST(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient();

  const { data: dv } = await admin
    .from("dealer_vehicles")
    .select("dealer_id, status")
    .eq("id", params.vehicleId)
    .maybeSingle();

  if (!dv) {
    return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
  }

  // dealer roles → own; group_admin/group_user → in-group (tag-scoped);
  // super_admin → any (incl. ghost).
  const authz = await authorizeDealerAction(claims, dv.dealer_id as string);
  if (!authz.ok) return authz.response;

  if (dv.status !== "active") {
    return NextResponse.json({ error: "Vehicle is not active" }, { status: 400 });
  }

  const errMsg = await applyQueueUpdate(admin, params.vehicleId, {
    print_queue: 1,
    print_queue_at: new Date().toISOString(),
    print_queue_by: claims.sub,
  });
  if (errMsg) return NextResponse.json({ error: errMsg }, { status: 500 });

  return NextResponse.json({ queued: true, vehicle_id: params.vehicleId });
}

/**
 * DELETE /api/print-queue/[vehicleId]
 * Remove a vehicle from the print queue (unqueue without printing).
 */
export async function DELETE(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient();

  const { data: dv } = await admin
    .from("dealer_vehicles")
    .select("dealer_id")
    .eq("id", params.vehicleId)
    .maybeSingle();

  if (!dv) {
    return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
  }

  const authz = await authorizeDealerAction(claims, dv.dealer_id as string);
  if (!authz.ok) return authz.response;

  const errMsg = await applyQueueUpdate(admin, params.vehicleId, {
    print_queue: 0,
    print_queue_at: null,
    print_queue_by: null,
  });
  if (errMsg) return NextResponse.json({ error: errMsg }, { status: 500 });

  return NextResponse.json({ queued: false, vehicle_id: params.vehicleId });
}
