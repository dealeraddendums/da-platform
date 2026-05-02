import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";

// Public endpoint — called by Dealer.com DMS webhooks. No auth required.
// Returns vehicle pricing + addendum options for a given VIN + stock number.

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = req.nextUrl;
  const vin   = (searchParams.get("vin")   ?? "").toUpperCase();
  const stock = searchParams.get("stock") ?? "";

  if (!vin || !stock) {
    return NextResponse.json({ status: "failed", message: "VIN and stock are required." }, { status: 422 });
  }

  const admin = createAdminSupabaseClient();
  const { data: vehicle } = await admin
    .from("dealer_vehicles")
    .select("id, dealer_id, vin, stock_number, msrp, internet_price")
    .eq("vin", vin)
    .eq("stock_number", stock)
    .maybeSingle();

  if (!vehicle) {
    return NextResponse.json({ status: "failed", message: "Vehicle not found." }, { status: 422 });
  }

  const { data: options } = await admin
    .from("vehicle_options")
    .select("id, vehicle_id, option_name, description, option_price, dealer_id, created_at")
    .eq("vehicle_id", vehicle.id)
    .order("sort_order", { ascending: true });

  const optionRows = (options ?? []).map((o) => ({
    _ID: o.id,
    VEHICLE_ID: o.vehicle_id,
    ITEM_NAME: o.option_name,
    ITEM_DESCRIPTION: o.description ?? "",
    ITEM_PRICE: o.option_price ?? "NC",
    ACTIVE: "1",
    DEALER_ID: o.dealer_id,
    CREATION_DATE: o.created_at,
    VIN_NUMBER: vin,
  }));

  return NextResponse.json({
    _ID: vehicle.id,
    DEALER_ID: vehicle.dealer_id,
    VIN_NUMBER: vehicle.vin,
    STOCK_NUMBER: vehicle.stock_number,
    MSRP: vehicle.msrp,
    INTERNET_PRICE: vehicle.internet_price ?? vehicle.msrp,
    options: optionRows,
  });
}
