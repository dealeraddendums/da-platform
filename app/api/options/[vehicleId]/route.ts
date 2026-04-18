import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { getPool } from "@/lib/aurora";
import type { VehicleRowPacket } from "@/lib/aurora";
import { matchOptionsToVehicle, getAuroraAppliedOptions, getGroupOptionsForDealer } from "@/lib/options-engine";
import type { VehicleOptionRow } from "@/lib/db";

type Params = { params: { vehicleId: string } };

function dealerScope(claims: { role: string; dealer_id: string | null; group_id: string | null }) {
  return claims.role === "dealer_admin" || claims.role === "dealer_user"
    ? claims.dealer_id
    : null;
}

/**
 * GET /api/options/[vehicleId]
 * Returns saved vehicle_options from Supabase.
 * If none exist yet, seeds from addendum_data (Aurora legacy) then falls back to matched defaults.
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

  // Fetch vehicle to get dealer_id + fields needed for matching
  const pool = getPool();
  const [vrows] = await pool.execute<VehicleRowPacket[]>(
    `SELECT id, DEALER_ID, VIN_NUMBER, YEAR, MAKE, MODEL, TRIM, BODYSTYLE,
            MILEAGE, MSRP, NEW_USED, CERTIFIED
     FROM dealer_inventory WHERE id = ? LIMIT 1`,
    [vehicleId]
  );
  if (!vrows.length) {
    return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
  }
  const vehicle = vrows[0];
  const dealerId = vehicle.DEALER_ID; // TODO: verify this should use inventory_dealer_id when comparing against claims.dealer_id

  // Scope check
  const scopedDealer = dealerScope(claims);
  if (scopedDealer && scopedDealer !== dealerId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();

  // Check for saved options in Supabase
  const { data: saved } = await admin
    .from("vehicle_options")
    .select("*")
    .eq("vehicle_id", vehicleId)
    .eq("dealer_id", dealerId)
    .order("sort_order", { ascending: true });

  // Fetch group-level locked options (always prepended, never stored per-vehicle)
  const groupOptions = await getGroupOptionsForDealer(dealerId);

  if (saved && saved.length > 0) {
    return NextResponse.json({ data: saved, groupOptions, source: "saved" });
  }

  // No saved options — seed from Aurora addendum_data first
  const auroraOptions = await getAuroraAppliedOptions(vehicleId, dealerId);

  if (auroraOptions.length > 0) {
    // Persist Aurora options to Supabase so they're editable
    const inserts = auroraOptions.map((o, i) => ({
      vehicle_id: vehicleId,
      dealer_id: dealerId,
      option_name: o.option_name,
      option_price: o.option_price,
      sort_order: i,
      source: "default" as const,
    }));
    const { data: inserted } = await admin
      .from("vehicle_options")
      .insert(inserts)
      .select("*");
    return NextResponse.json({ data: inserted ?? inserts, groupOptions, source: "aurora_seeded" });
  }

  // Fall back to matching defaults from addendum_defaults
  const matched = await matchOptionsToVehicle(vehicle, dealerId);
  return NextResponse.json({ data: matched, groupOptions, source: "matched", saved: false });
}

/**
 * POST /api/options/[vehicleId]
 * Replaces all options for a vehicle (batch save).
 * Body: { options: { option_name, option_price, sort_order, source }[] }
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

  type OptionInput = Pick<VehicleOptionRow, "option_name" | "option_price" | "sort_order" | "source">;
  const body = await req.json() as { options?: OptionInput[]; dealer_id?: string };
  if (!body.options || !Array.isArray(body.options)) {
    return NextResponse.json({ error: "options array required" }, { status: 400 });
  }

  const pool = getPool();
  const [vrows] = await pool.execute<VehicleRowPacket[]>(
    "SELECT DEALER_ID FROM dealer_inventory WHERE id = ? LIMIT 1",
    [vehicleId]
  );
  if (!vrows.length) {
    return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
  }
  const dealerId = vrows[0].DEALER_ID;

  const scopedDealer = dealerScope(claims);
  if (scopedDealer && scopedDealer !== dealerId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();

  // Delete existing and re-insert
  await admin.from("vehicle_options").delete().eq("vehicle_id", vehicleId).eq("dealer_id", dealerId);

  const inserts = body.options.map((o, i) => ({
    vehicle_id: vehicleId,
    dealer_id: dealerId,
    option_name: o.option_name,
    option_price: o.option_price ?? "NC",
    sort_order: o.sort_order ?? i,
    source: o.source ?? "manual",
  }));

  const { data, error: insertErr } = await admin
    .from("vehicle_options")
    .insert(inserts)
    .select("*");

  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  return NextResponse.json({ data });
}
