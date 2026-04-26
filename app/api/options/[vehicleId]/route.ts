import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { getPool } from "@/lib/aurora";
import type { VehicleRowPacket } from "@/lib/aurora";
import { matchOptionsToVehicle, getAuroraAppliedOptions, getGroupOptionsForDealer } from "@/lib/options-engine";
import type { VehicleOptionRow } from "@/lib/db";

type Params = { params: { vehicleId: string } };

function isUUID(v: string) { return v.includes("-"); }
function isManual(v: string) { return isUUID(v) || v === "0"; }

/**
 * GET /api/options/[vehicleId]
 * vehicleId can be:
 *   - UUID string: manual dealer_vehicle (dealer_vehicles.id)
 *   - "0":         legacy sentinel (backward compat, treated as manual)
 *   - numeric:     Aurora vehicle ID
 */
export async function GET(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  try {
    const { claims, error } = await requireAuth();
    if (error) return error;

    const vid = params.vehicleId;
    const admin = createAdminSupabaseClient();
    const effectiveDealerId = claims.impersonating_dealer_id ?? claims.dealer_id;

    // ── Manual vehicle path (UUID or legacy '0') ─────────────────────────────
    if (isManual(vid)) {
      if (!effectiveDealerId) {
        return NextResponse.json({ data: [], groupOptions: [], source: "empty" });
      }

      const groupOptions = await getGroupOptionsForDealer(effectiveDealerId);

      // Check for saved options keyed by this vehicleId
      const { data: saved } = await admin
        .from("vehicle_options")
        .select("*")
        .eq("vehicle_id", vid)
        .eq("dealer_id", effectiveDealerId)
        .order("sort_order", { ascending: true });

      if (saved && saved.length > 0) {
        return NextResponse.json({ data: saved, groupOptions, source: "saved" });
      }

      // If UUID and nothing found, also check legacy '0' sentinel as fallback
      if (isUUID(vid)) {
        const { data: legacySaved } = await admin
          .from("vehicle_options")
          .select("*")
          .eq("vehicle_id", "0")
          .eq("dealer_id", effectiveDealerId)
          .order("sort_order", { ascending: true });

        if (legacySaved && legacySaved.length > 0) {
          return NextResponse.json({ data: legacySaved, groupOptions, source: "saved" });
        }
      }

      // No saved options — seed from dealer's addendum_library
      const { data: library } = await admin
        .from("addendum_library")
        .select("*")
        .eq("dealer_id", effectiveDealerId)
        .eq("active", true)
        .neq("applies_to", "none")
        .order("sort_order", { ascending: true });

      const matched = (library ?? []).map((r, i) => ({
        default_id: r.id,
        option_name: r.option_name,
        option_price: r.item_price ?? "NC",
        description: r.description ?? null,
        sort_order: r.sort_order ?? i,
        source: "default" as const,
      }));

      return NextResponse.json({ data: matched, groupOptions, source: "matched", saved: false });
    }

    // ── Aurora vehicle path ──────────────────────────────────────────────────
    const vehicleIdNum = parseInt(vid, 10);
    if (isNaN(vehicleIdNum)) {
      return NextResponse.json({ error: "Invalid vehicleId" }, { status: 400 });
    }

    const pool = getPool();
    const [vrows] = await pool.execute<VehicleRowPacket[]>(
      `SELECT id, DEALER_ID, VIN_NUMBER, YEAR, MAKE, MODEL, TRIM, BODYSTYLE,
              MILEAGE, MSRP, NEW_USED, CERTIFIED
       FROM dealer_inventory WHERE id = ? LIMIT 1`,
      [vehicleIdNum]
    );
    if (!vrows.length) {
      return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
    }
    const vehicle = vrows[0];
    const dealerId = vehicle.DEALER_ID;

    const isDealer = claims.role === "dealer_admin" || claims.role === "dealer_user";
    if (isDealer && effectiveDealerId && effectiveDealerId !== dealerId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { data: saved } = await admin
      .from("vehicle_options")
      .select("*")
      .eq("vehicle_id", vid)
      .eq("dealer_id", dealerId)
      .order("sort_order", { ascending: true });

    const groupOptions = await getGroupOptionsForDealer(dealerId);

    if (saved && saved.length > 0) {
      return NextResponse.json({ data: saved, groupOptions, source: "saved" });
    }

    const auroraOptions = await getAuroraAppliedOptions(vehicleIdNum, dealerId);

    if (auroraOptions.length > 0) {
      const inserts = auroraOptions.map((o, i) => ({
        vehicle_id: vid,
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

    const matched = await matchOptionsToVehicle(vehicle, dealerId);
    return NextResponse.json({ data: matched, groupOptions, source: "matched", saved: false });

  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[options GET]", msg);
    return NextResponse.json({ error: msg, data: [], groupOptions: [] }, { status: 500 });
  }
}

/**
 * POST /api/options/[vehicleId]
 * Replaces all options for a vehicle (batch save).
 */
export async function POST(
  req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  try {
    const { claims, error } = await requireAuth();
    if (error) return error;

    const vid = params.vehicleId;
    type OptionInput = Pick<VehicleOptionRow, "option_name" | "option_price" | "sort_order" | "source"> & { description?: string | null };
    const body = await req.json() as { options?: OptionInput[]; dealer_id?: string };
    if (!body.options || !Array.isArray(body.options)) {
      return NextResponse.json({ error: "options array required" }, { status: 400 });
    }

    const effectiveDealerId = claims.impersonating_dealer_id ?? claims.dealer_id;
    const admin = createAdminSupabaseClient();

    // Manual vehicle path (UUID or legacy '0')
    if (isManual(vid)) {
      if (!effectiveDealerId) {
        return NextResponse.json({ error: "No dealer context" }, { status: 403 });
      }
      await admin.from("vehicle_options").delete().eq("vehicle_id", vid).eq("dealer_id", effectiveDealerId);
      // Also clear legacy '0' sentinel if saving under UUID (migrate on write)
      if (isUUID(vid)) {
        await admin.from("vehicle_options").delete().eq("vehicle_id", "0").eq("dealer_id", effectiveDealerId);
      }
      const inserts = body.options.map((o, i) => ({
        vehicle_id: vid,
        dealer_id: effectiveDealerId,
        option_name: o.option_name,
        option_price: o.option_price ?? "NC",
        description: o.description ?? null,
        sort_order: o.sort_order ?? i,
        source: o.source ?? "manual",
      }));
      const { data, error: insertErr } = await admin.from("vehicle_options").insert(inserts).select("*");
      if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });
      return NextResponse.json({ data });
    }

    // Aurora vehicle path
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
    const dealerId = vrows[0].DEALER_ID;

    const isDealer = claims.role === "dealer_admin" || claims.role === "dealer_user";
    if (isDealer && effectiveDealerId && effectiveDealerId !== dealerId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    await admin.from("vehicle_options").delete().eq("vehicle_id", vid).eq("dealer_id", dealerId);

    const inserts = body.options.map((o, i) => ({
      vehicle_id: vid,
      dealer_id: dealerId,
      option_name: o.option_name,
      option_price: o.option_price ?? "NC",
      description: o.description ?? null,
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

  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[options POST]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
