import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { getPool } from "@/lib/aurora";
import type { VehicleRowPacket } from "@/lib/aurora";

type Params = { params: { vehicleId: string } };

function isManual(v: string) { return v.includes("-") || v === "0"; }

/**
 * POST /api/options/[vehicleId]/add
 * Adds a single option to a vehicle.
 * Body: { option_name, option_price?, sort_order?, description? }
 */
export async function POST(
  req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const vid = params.vehicleId;

  const body = await req.json() as { option_name?: string; option_price?: string; sort_order?: number; description?: string | null };
  if (!body.option_name?.trim()) {
    return NextResponse.json({ error: "option_name required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const effectiveDealerId = claims.impersonating_dealer_id ?? claims.dealer_id;

  let dealerId: string;

  if (isManual(vid)) {
    // Manual vehicle — use effective dealer context, no Aurora lookup
    if (!effectiveDealerId) {
      return NextResponse.json({ error: "No dealer context" }, { status: 403 });
    }
    dealerId = effectiveDealerId;
  } else {
    // Aurora vehicle — look up dealer from Aurora
    const vehicleIdNum = parseInt(vid, 10);
    if (isNaN(vehicleIdNum)) {
      return NextResponse.json({ error: "Invalid vehicleId" }, { status: 400 });
    }
    const pool = getPool();
    const [vrows] = await pool.execute<VehicleRowPacket[]>(
      "SELECT DEALER_ID FROM dealer_inventory WHERE id = ? LIMIT 1",
      [vehicleIdNum]
    );
    if (!vrows.length) {
      return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
    }
    dealerId = vrows[0].DEALER_ID;
    if (
      (claims.role === "dealer_admin" || claims.role === "dealer_user") &&
      effectiveDealerId !== dealerId
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // Get current max sort_order
  const { data: maxRow } = await admin
    .from("vehicle_options")
    .select("sort_order")
    .eq("vehicle_id", vid)
    .eq("dealer_id", dealerId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .single();

  const sortOrder = body.sort_order ?? ((maxRow?.sort_order ?? -1) + 1);

  const { data, error: err } = await admin
    .from("vehicle_options")
    .insert({
      vehicle_id: vid,
      dealer_id: dealerId,
      option_name: body.option_name.trim(),
      option_price: body.option_price?.trim() ?? "NC",
      description: body.description ?? null,
      sort_order: sortOrder,
      source: "manual",
    })
    .select("*")
    .single();

  if (err) return NextResponse.json({ error: err.message }, { status: 500 });
  return NextResponse.json({ data });
}
