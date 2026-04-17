import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/aurora";
import { checkPdfExists } from "@/lib/addendum";
import type { RowDataPacket } from "mysql2/promise";

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

  try {
    if (feature === "button") {
      const addendumUrl = await checkPdfExists(vin);
      if (!addendumUrl) {
        return NextResponse.json({ status: "fail", feature: "button", vin, message: "Addendum does not exist for this VIN." });
      }
      return NextResponse.json({ status: "success", feature: "button", vin, addendum_url: addendumUrl });
    }

    // pricing or both
    const pool = getPool();
    const [vehicleRows] = await pool.query<RowDataPacket[]>(
      "SELECT _ID, DEALER_ID, VIN_NUMBER, STOCK_NUMBER, MSRP, INTERNET_PRICE FROM dealer_inventory WHERE VIN_NUMBER = ? AND STOCK_NUMBER = ? LIMIT 1",
      [vin, stock]
    );

    if (!vehicleRows.length) {
      return NextResponse.json({ status: "failed", message: "Invalid Request." }, { status: 422 });
    }

    const v = vehicleRows[0];
    const [optionRows] = await pool.query<RowDataPacket[]>(
      "SELECT ITEM_NAME as name, ITEM_DESCRIPTION as description, ITEM_PRICE as price FROM addendum_data WHERE VIN_NUMBER = ? AND ACTIVE = '1' ORDER BY RE_ORDER, _ID",
      [vin]
    );

    const msrp = parseFloat(String(v.MSRP || 0)) || 0;
    const internetPrice = parseFloat(String(v.INTERNET_PRICE || 0)) || 0;
    const options = optionRows as unknown as { name: string; description: string; price: string }[];

    if (feature === "pricing") {
      return NextResponse.json({ status: "success", feature: "pricing", vin, msrp, internet_price: internetPrice, options });
    }

    // both
    const addendumUrl = await checkPdfExists(vin);
    return NextResponse.json({ status: "success", feature: "both", vin, msrp, internet_price: internetPrice, options, addendum_url: addendumUrl });

  } catch (err) {
    const msg = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ status: "failed", message: msg }, { status: 503 });
  }
}
