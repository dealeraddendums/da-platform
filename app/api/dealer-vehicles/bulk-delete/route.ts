import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { VehicleAuditLogInsert } from "@/lib/db";

/** POST /api/dealer-vehicles/bulk-delete — delete multiple vehicles by ID */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const { claims, error } = await requireAuth();
    if (error) return error;

    const isAdmin = (claims.role === "super_admin" || claims.role === "group_admin") && !claims.impersonating_dealer_id;
    if (isAdmin) return NextResponse.json({ error: "Not available for admin roles" }, { status: 403 });

    const dealerId = claims.impersonating_dealer_id ?? claims.dealer_id;
    if (!dealerId) return NextResponse.json({ error: "No dealer assigned" }, { status: 403 });

    const { ids } = await req.json() as { ids?: string[] };
    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: "No IDs provided" }, { status: 422 });
    }

    const admin = createAdminSupabaseClient();

    // Fetch vehicles to log before deleting (audit log entries cascade-delete with vehicle)
    const { data: vehicles } = await admin
      .from("dealer_vehicles")
      .select("id, stock_number")
      .in("id", ids)
      .eq("dealer_id", dealerId);

    if (vehicles?.length) {
      const logEntries: VehicleAuditLogInsert[] = vehicles.map((v) => ({
        dealer_id: dealerId,
        vehicle_id: v.id,
        stock_number: v.stock_number,
        action: "delete" as const,
        changed_by: claims.sub,
        changed_by_email: claims.email,
      }));
      void admin.from("vehicle_audit_log").insert(logEntries);
    }

    const { error: delErr } = await admin
      .from("dealer_vehicles")
      .delete()
      .in("id", ids)
      .eq("dealer_id", dealerId);

    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });
    return NextResponse.json({ deleted: vehicles?.length ?? 0 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
