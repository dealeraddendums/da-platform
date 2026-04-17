import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getPool } from "@/lib/aurora";
import type { RowDataPacket } from "mysql2/promise";

// Legacy: required key + username + vin. New: Supabase JWT + vin.
// dealer_admin/user scoped to own dealer; super_admin can pass dealership_id param.

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const { searchParams } = req.nextUrl;
  const vin = searchParams.get("vin") ?? "";
  if (!vin) {
    return NextResponse.json({ status: "failed", message: "API Key, Username, VIN required." }, { status: 422 });
  }

  // Resolve dealer scope
  let dealerId: string | null = null;
  if (claims.role === "dealer_admin" || claims.role === "dealer_user") {
    dealerId = claims.dealer_id;
  } else {
    dealerId = searchParams.get("dealership_id") ?? null;
  }

  try {
    const pool = getPool();
    const cols = "DEALER_ID, VIN_NUMBER, STOCK_NUMBER, YEAR, MAKE, MODEL, BODYSTYLE, DOORS, TRIM, EXT_COLOR, INT_COLOR, ENGINE, FUEL, DRIVETRAIN, TRANSMISSION, MILEAGE, DATE_IN_STOCK, PRINT_STATUS, MSRP, PRINT_DATE, INPUT_DATE, NEW_USED";

    let result: RowDataPacket | undefined;
    if (dealerId) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT ${cols} FROM dealer_inventory WHERE DEALER_ID = ? AND VIN_NUMBER = ? LIMIT 1`,
        [dealerId, vin]
      );
      result = rows[0];
    } else {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT ${cols} FROM dealer_inventory WHERE VIN_NUMBER = ? LIMIT 1`,
        [vin]
      );
      result = rows[0];
    }

    if (!result) {
      return NextResponse.json({ status: "failed", message: "VIN Not Found." }, { status: 422 });
    }

    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ status: "failed", message: msg }, { status: 503 });
  }
}
