import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { VehicleAuditLogInsert } from "@/lib/db";

/**
 * POST /api/dealers/[dealerId]/clear-print-history
 * Deletes print_history and addendum_data for active vehicles of a dealer.
 * dealer_admin: own dealer only. super_admin: any dealer.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const dealerId = params.id;
  if (!dealerId) return NextResponse.json({ error: "dealerId required" }, { status: 400 });

  // dealer_admin can only clear their own dealer
  if (claims.role === "dealer_admin" || claims.role === "dealer_user") {
    if (claims.dealer_id !== dealerId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else if (claims.role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();

  // Fetch active vehicle IDs for this dealer
  const { data: activeVehicles, error: vErr } = await admin
    .from("dealer_vehicles")
    .select("id")
    .eq("dealer_id", dealerId)
    .eq("status", "active");

  if (vErr) return NextResponse.json({ error: vErr.message }, { status: 500 });

  const activeIds = (activeVehicles ?? []).map(v => v.id as string);
  if (activeIds.length === 0) {
    return NextResponse.json({ cleared_vehicles: 0 });
  }

  // Delete print_history for active vehicles
  const { error: phErr } = await admin
    .from("print_history")
    .delete()
    .eq("dealer_id", dealerId)
    .in("vehicle_id", activeIds);

  if (phErr) return NextResponse.json({ error: phErr.message }, { status: 500 });

  // Delete addendum_data for active vehicles — need dealer UUID for FK
  const { data: dealerRow } = await admin
    .from("dealers")
    .select("id")
    .eq("dealer_id", dealerId)
    .maybeSingle<{ id: string }>();

  if (dealerRow?.id) {
    await admin
      .from("addendum_data")
      .delete()
      .eq("dealer_id", dealerRow.id)
      .in("vehicle_id", activeIds);
  }

  // Log to vehicle_audit_log for each affected vehicle (fire-and-forget)
  const logRows: VehicleAuditLogInsert[] = activeIds.map(vid => ({
    dealer_id: dealerId,
    vehicle_id: vid,
    action: "print_history_cleared" as const,
    method: "manual",
    changed_by: claims.sub,
  }));
  if (logRows.length > 0) {
    await admin.from("vehicle_audit_log").insert(logRows);
  }

  return NextResponse.json({ cleared_vehicles: activeIds.length });
}
