import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/aurora";
import type { RowDataPacket } from "mysql2/promise";

// Public endpoint — called by Dealer.com DMS webhooks. No auth required.
// Returns vehicle pricing + addendum options for a given VIN + stock number.

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = req.nextUrl;
  const vin   = (searchParams.get("vin")   ?? "").toUpperCase();
  const stock = searchParams.get("stock") ?? "";

  if (!vin || !stock) {
    return NextResponse.json({ status: "failed", message: "VIN and stock are required." }, { status: 422 });
  }

  try {
    const pool = getPool();
    const [vehicleRows] = await pool.query<RowDataPacket[]>(
      "SELECT _ID, DEALER_ID, VIN_NUMBER, STOCK_NUMBER, MSRP, INTERNET_PRICE FROM dealer_inventory WHERE VIN_NUMBER = ? AND STOCK_NUMBER = ? LIMIT 1",
      [vin, stock]
    );

    if (!vehicleRows.length) {
      return NextResponse.json({ status: "failed", message: "Vehicle not found." }, { status: 422 });
    }

    const vehicle = vehicleRows[0];
    const [optionRows] = await pool.query<RowDataPacket[]>(
      "SELECT _ID, VEHICLE_ID, ITEM_NAME, ITEM_DESCRIPTION, ITEM_PRICE, ACTIVE, DEALER_ID, CREATION_DATE, VIN_NUMBER FROM addendum_data WHERE VIN_NUMBER = ? AND ACTIVE = '1' ORDER BY RE_ORDER, _ID",
      [vin]
    );

    return NextResponse.json({ ...vehicle, options: optionRows });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ status: "failed", message: msg }, { status: 503 });
  }
}
