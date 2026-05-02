import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

// Legacy: required key + vin. New: Supabase JWT + vin.
// Data source: Supabase addendum_data (print compliance log)

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const vin = (req.nextUrl.searchParams.get("vin") ?? "").toUpperCase();
  if (!vin) {
    return NextResponse.json({ status: "failed", message: "API Key, Username, VIN required." }, { status: 422 });
  }

  if (!claims.dealer_id && claims.role !== "super_admin") {
    return NextResponse.json({ status: "failed", message: "No dealer assigned." }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();

  let query = admin
    .from("addendum_data")
    .select("id, vehicle_id, item_name, item_description, item_price, legacy_dealer_id, printed_at, vin_number")
    .eq("vin_number", vin)
    .order("printed_at", { ascending: true });

  // Scope to dealer unless super_admin
  if (claims.role !== "super_admin" && claims.dealer_id) {
    query = query.eq("legacy_dealer_id", claims.dealer_id) as typeof query;
  }

  const { data, error: dbErr } = await query;

  if (dbErr) {
    return NextResponse.json({ status: "failed", message: dbErr.message }, { status: 500 });
  }

  const mapped = (data ?? []).map((r) => ({
    _ID: r.id,
    VEHICLE_ID: r.vehicle_id,
    ITEM_NAME: r.item_name,
    ITEM_DESCRIPTION: r.item_description ?? "",
    ITEM_PRICE: r.item_price ?? "NC",
    ACTIVE: "1",
    DEALER_ID: r.legacy_dealer_id,
    CREATION_DATE: r.printed_at,
    VIN_NUMBER: r.vin_number ?? vin,
  }));

  return NextResponse.json(mapped);
}
