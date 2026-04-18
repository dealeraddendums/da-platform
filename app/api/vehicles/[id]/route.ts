import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getPool } from "@/lib/aurora";
import type { VehicleRowPacket } from "@/lib/aurora";
import { createAdminSupabaseClient } from "@/lib/db";

type Params = { params: { id: string } };

/**
 * GET /api/vehicles/[id]
 * Returns full vehicle row including OPTIONS, DESCRIPTION, all photos.
 * Access control: dealer users can only see their own dealer's vehicles.
 */
export async function GET(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const vehicleId = parseInt(params.id, 10);
  if (isNaN(vehicleId)) {
    return NextResponse.json({ error: "Invalid vehicle id" }, { status: 400 });
  }

  try {
    const pool = getPool();
    const [rows] = await pool.query<VehicleRowPacket[]>(
      "SELECT * FROM vehicles WHERE id = ?",
      [vehicleId]
    );

    if (!rows.length) {
      return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
    }

    const vehicle = rows[0] as VehicleRowPacket;

    // Access control: dealer users can only see their own dealer's vehicles
    // TODO: verify this should use inventory_dealer_id (claims.dealer_id is Supabase; vehicle.DEALER_ID is Aurora)
    if (claims.role === "dealer_admin" || claims.role === "dealer_user") {
      if (vehicle.DEALER_ID !== claims.dealer_id) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    } else if (claims.role === "group_admin") {
      // Verify this dealer is in their group
      const admin = createAdminSupabaseClient();
      const { data: dealer } = await admin
        .from("dealers")
        .select("group_id")
        .eq("dealer_id", vehicle.DEALER_ID)
        .single();
      if (!dealer || dealer.group_id !== claims.group_id) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    return NextResponse.json({ data: vehicle });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Aurora connection failed";
    return NextResponse.json({ error: msg }, { status: 503 });
  }
}
