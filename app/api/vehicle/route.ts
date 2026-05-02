import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { checkPdfExists } from "@/lib/addendum";

// Public endpoint — no JWT required.
// Used by dealer websites and DMS integrations via iframe/script embeds.

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = req.nextUrl;
  const vin = (searchParams.get("vin") ?? "").toUpperCase();
  const feature = searchParams.get("feature") ?? "";
  const stock = searchParams.get("stock") ?? "";

  if (!vin || !["pricing", "button", "both"].includes(feature)) {
    return NextResponse.json({
      status: "failed",
      message: "Missing or invalid parameters. Required: vin, feature (pricing|button|both).",
    }, { status: 422 });
  }

  if ((feature === "pricing" || feature === "both") && !stock) {
    return NextResponse.json({
      status: "failed",
      message: 'Parameter "stock" is required when feature is "pricing" or "both".',
    }, { status: 422 });
  }

  if (feature === "button") {
    const addendumUrl = await checkPdfExists(vin);
    if (!addendumUrl) {
      return NextResponse.json({ status: "fail", feature: "button", vin, message: "Addendum does not exist for this VIN." });
    }
    return NextResponse.json({ status: "success", feature: "button", vin, addendum_url: addendumUrl });
  }

  // pricing or both
  const admin = createAdminSupabaseClient();
  const { data: vehicle } = await admin
    .from("dealer_vehicles")
    .select("id, msrp, internet_price")
    .eq("vin", vin)
    .eq("stock_number", stock)
    .maybeSingle();

  if (!vehicle) {
    return NextResponse.json({ status: "failed", message: "Invalid Request." }, { status: 422 });
  }

  const { data: optRows } = await admin
    .from("vehicle_options")
    .select("option_name, description, option_price")
    .eq("vehicle_id", vehicle.id)
    .order("sort_order", { ascending: true });

  const msrp = parseFloat(String(vehicle.msrp || 0)) || 0;
  const internetPrice = parseFloat(String(vehicle.internet_price || vehicle.msrp || 0)) || 0;
  const options = (optRows ?? []).map((o) => ({
    name: o.option_name,
    description: o.description ?? "",
    price: o.option_price ?? "NC",
  }));

  if (feature === "pricing") {
    return NextResponse.json({ status: "success", feature: "pricing", vin, msrp, internet_price: internetPrice, options });
  }

  // both
  const addendumUrl = await checkPdfExists(vin);
  return NextResponse.json({ status: "success", feature: "both", vin, msrp, internet_price: internetPrice, options, addendum_url: addendumUrl });
}
