import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

type Params = { params: { id: string } };

function isUUID(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/**
 * GET /api/vehicles/[id]
 * Returns full vehicle row from Supabase dealer_vehicles.
 * Only UUID ids are supported.
 * Access control: dealer users can only see their own dealer's vehicles.
 */
export async function GET(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (!isUUID(params.id)) {
    return NextResponse.json({ error: "Invalid vehicle id" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const { data: vehicle, error: dbErr } = await admin
    .from("dealer_vehicles")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();

  if (dbErr) {
    return NextResponse.json({ error: dbErr.message }, { status: 500 });
  }

  if (!vehicle) {
    return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
  }

  // Access control: dealer users can only see their own dealer's vehicles
  if (claims.role === "dealer_admin" || claims.role === "dealer_user") {
    if (vehicle.dealer_id !== claims.dealer_id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else if (claims.role === "group_admin") {
    const { data: dealer } = await admin
      .from("dealers")
      .select("group_id")
      .eq("dealer_id", vehicle.dealer_id)
      .single();
    if (!dealer || dealer.group_id !== claims.group_id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  return NextResponse.json({ data: vehicle });
}
