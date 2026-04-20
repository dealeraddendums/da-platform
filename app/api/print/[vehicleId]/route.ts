import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { AddendumHistoryInsert } from "@/lib/db";
import { getPool } from "@/lib/aurora";
import type { VehicleRowPacket } from "@/lib/aurora";

type Params = { params: { vehicleId: string } };

/**
 * POST /api/print/[vehicleId]
 * Logs a print event to print_history.
 * Body: { document_type: 'addendum'|'infosheet'|'buyer_guide', template_id?: string }
 */
export async function POST(
  req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const vehicleId = parseInt(params.vehicleId, 10);
  if (isNaN(vehicleId)) {
    return NextResponse.json({ error: "Invalid vehicleId" }, { status: 400 });
  }

  const body = await req.json() as {
    document_type?: string;
    template_id?: string;
    options?: { option_name: string; option_price?: string }[];
    vin?: string;
  };

  const docType = body.document_type as "addendum" | "infosheet" | "buyer_guide";
  if (!["addendum", "infosheet", "buyer_guide"].includes(docType)) {
    return NextResponse.json({ error: "Invalid document_type" }, { status: 400 });
  }

  const pool = getPool();
  const [vrows] = await pool.execute<VehicleRowPacket[]>(
    "SELECT DEALER_ID FROM dealer_inventory WHERE id = ? LIMIT 1",
    [vehicleId]
  );
  if (!vrows.length) {
    return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
  }
  const dealerId = vrows[0].DEALER_ID; // TODO: verify this should use inventory_dealer_id when comparing against claims.dealer_id

  if (
    (claims.role === "dealer_admin" || claims.role === "dealer_user") &&
    claims.dealer_id !== dealerId
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();
  const { data, error: err } = await admin
    .from("print_history")
    .insert({
      vehicle_id: vehicleId,
      dealer_id: dealerId,
      document_type: docType,
      printed_by: claims.sub,
      template_id: body.template_id ?? null,
    })
    .select("*")
    .single();

  if (err) return NextResponse.json({ error: err.message }, { status: 500 });

  // Write per-option addendum_history rows
  if (body.options && body.options.length > 0) {
    const today = new Date().toISOString().split("T")[0];
    const historyRows: AddendumHistoryInsert[] = body.options.map((o, i) => ({
      legacy_id:    null,
      vehicle_id:   vehicleId,
      vin:          body.vin ?? null,
      dealer_id:    dealerId,
      item_name:    o.option_name,
      item_description: null,
      item_price:   o.option_price ?? null,
      active:       "Yes",
      creation_date: today,
      order_by:     i,
      source:       "platform",
      created_at:   new Date().toISOString(),
      updated_at:   new Date().toISOString(),
    }));
    await admin.from("addendum_history").insert(historyRows);
  }

  return NextResponse.json({ data });
}

/**
 * GET /api/print/[vehicleId]
 * Returns print history for a vehicle.
 */
export async function GET(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const vehicleId = parseInt(params.vehicleId, 10);
  if (isNaN(vehicleId)) {
    return NextResponse.json({ error: "Invalid vehicleId" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // Get dealer_id from first history row or from vehicle
  const pool = getPool();
  const [vrows] = await pool.execute<VehicleRowPacket[]>(
    "SELECT DEALER_ID FROM dealer_inventory WHERE id = ? LIMIT 1",
    [vehicleId]
  );
  if (!vrows.length) {
    return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
  }
  const dealerId = vrows[0].DEALER_ID;

  if (
    (claims.role === "dealer_admin" || claims.role === "dealer_user") &&
    claims.dealer_id !== dealerId
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data, error: err } = await admin
    .from("print_history")
    .select("*")
    .eq("vehicle_id", vehicleId)
    .order("created_at", { ascending: false });

  if (err) return NextResponse.json({ error: err.message }, { status: 500 });
  return NextResponse.json({ data });
}
