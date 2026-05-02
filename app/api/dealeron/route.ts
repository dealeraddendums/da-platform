import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";

// Public endpoint — called by DealerOn DMS webhooks. No auth required.
// Same shape as /dealerdotcom but options have a slightly trimmed schema.

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
    .select("id, option_name, description, option_price")
    .eq("vehicle_id", vehicle.id)
    .order("sort_order", { ascending: true });

  const optionRows = (options ?? []).map((o) => ({
    _ID: o.id,
    ITEM_NAME: o.option_name,
    ITEM_DESCRIPTION: o.description ?? "",
    ITEM_PRICE: o.option_price ?? "NC",
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
