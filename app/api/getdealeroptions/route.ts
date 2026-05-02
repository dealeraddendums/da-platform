import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

// Legacy: required key (resolves dealer_id from KeyOwner), optional from/to dates.
// New: Supabase JWT; dealer_id from claims.
// Data source: Supabase addendum_data (the print compliance log)

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (!claims.dealer_id) {
    return NextResponse.json({ status: "failed", message: "No dealer assigned." }, { status: 403 });
  }

  const { searchParams } = req.nextUrl;
  const from = searchParams.get("from") ?? null;
  const to = searchParams.get("to") ?? null;

  const admin = createAdminSupabaseClient();

  // addendum_data.dealer_id is UUID; use legacy_dealer_id for text-based lookup
  let query = admin
    .from("addendum_data")
    .select("id, vehicle_id, item_name, item_description, item_price, legacy_dealer_id, printed_at, vin_number")
    .eq("legacy_dealer_id", claims.dealer_id)
    .order("printed_at", { ascending: false });

  if (from) query = query.gte("printed_at", from) as typeof query;
  if (to)   query = query.lte("printed_at", to) as typeof query;

  const { data, error: dbErr } = await query;

  if (dbErr) {
    return NextResponse.json({ status: "failed", message: dbErr.message }, { status: 500 });
  }

  // Map to legacy column names
  const mapped = (data ?? []).map((r) => ({
    _ID: r.id,
    VEHICLE_ID: r.vehicle_id,
    ITEM_NAME: r.item_name,
    ITEM_DESCRIPTION: r.item_description ?? "",
    ITEM_PRICE: r.item_price ?? "NC",
    ACTIVE: "1",
    DEALER_ID: r.legacy_dealer_id,
    CREATION_DATE: r.printed_at,
    VIN_NUMBER: r.vin_number ?? null,
  }));

  return NextResponse.json(mapped);
}
