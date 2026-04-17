import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/aurora";
import type { RowDataPacket } from "mysql2/promise";

// Public endpoint — called by DealerOn DMS for wholesale price lookup. No auth required.

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = req.nextUrl;
  const vin   = (searchParams.get("vin")   ?? "").toUpperCase();
  const stock = searchParams.get("stock") ?? "";

  if (!vin || !stock) {
    return NextResponse.json({ status: "failed", message: "VIN and stock are required." }, { status: 422 });
  }

  try {
    const pool = getPool();
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT INTERNET_PRICE FROM dealer_inventory WHERE VIN_NUMBER = ? AND STOCK_NUMBER = ? LIMIT 1",
      [vin, stock]
    );

    if (!rows.length) {
      return NextResponse.json({ status: "failed", message: "Vehicle not found." }, { status: 422 });
    }

    const price = parseFloat(String(rows[0].INTERNET_PRICE || 0));
    const formatted = `$${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return new NextResponse(formatted, { status: 200, headers: { "Content-Type": "text/plain" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ status: "failed", message: msg }, { status: 503 });
  }
}
