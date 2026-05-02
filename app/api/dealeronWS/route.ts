import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";

// Public endpoint — called by DealerOn DMS for wholesale price lookup. No auth required.

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
    .select("internet_price, msrp")
    .eq("vin", vin)
    .eq("stock_number", stock)
    .maybeSingle();

  if (!vehicle) {
    return NextResponse.json({ status: "failed", message: "Vehicle not found." }, { status: 422 });
  }

  const price = parseFloat(String(vehicle.internet_price ?? vehicle.msrp ?? 0));
  const formatted = `$${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return new NextResponse(formatted, { status: 200, headers: { "Content-Type": "text/plain" } });
}
