import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getPool } from "@/lib/aurora";
import type { RowDataPacket } from "mysql2/promise";

// Legacy: required key + username + optional dealer + optional type.
// New: Supabase JWT; dealer scoped by role; pass ?dealer= to override (super_admin only).

const COLS = "DEALER_ID, VIN_NUMBER, STOCK_NUMBER, YEAR, MAKE, MODEL, BODYSTYLE, DOORS, TRIM, EXT_COLOR, INT_COLOR, ENGINE, FUEL, DRIVETRAIN, TRANSMISSION, MILEAGE, DATE_IN_STOCK, MSRP, INPUT_DATE, NEW_USED, STATUS";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const { searchParams } = req.nextUrl;

  let dealerId: string | null = null;
  if (claims.role === "dealer_admin" || claims.role === "dealer_user") {
    dealerId = claims.dealer_id;
  } else {
    dealerId = searchParams.get("dealer") ?? null;
  }

  if (!dealerId) {
    return NextResponse.json({ status: "failed", message: "API Key, Username required." }, { status: 422 });
  }

  try {
    const pool = getPool();
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT ${COLS} FROM dealer_inventory WHERE DEALER_ID = ? AND STATUS = '1' ORDER BY DATE_IN_STOCK DESC`,
      [dealerId]
    );
    return NextResponse.json(rows);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ status: "failed", message: msg }, { status: 503 });
  }
}
