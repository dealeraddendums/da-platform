import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getPool } from "@/lib/aurora";
import type { RowDataPacket } from "mysql2/promise";

// Legacy: required key + vin. New: Supabase JWT + vin.

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const vin = (req.nextUrl.searchParams.get("vin") ?? "").toUpperCase();
  if (!vin) {
    return NextResponse.json({ status: "failed", message: "API Key, Username, VIN required." }, { status: 422 });
  }

  if (!claims.dealer_id && claims.role !== "super_admin") {
    return NextResponse.json({ status: "failed", message: "No dealer assigned." }, { status: 403 });
  }

  try {
    const pool = getPool();
    const conditions = ["VIN_NUMBER = ?"];
    const params: unknown[] = [vin];

    // Scope to dealer unless super_admin
    if (claims.role !== "super_admin" && claims.dealer_id) {
      conditions.push("DEALER_ID = ?");
      params.push(claims.dealer_id);
    }

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT _ID, VEHICLE_ID, ITEM_NAME, ITEM_DESCRIPTION, ITEM_PRICE, ACTIVE, DEALER_ID, CREATION_DATE, VIN_NUMBER FROM addendum_data WHERE ${conditions.join(" AND ")} ORDER BY RE_ORDER, _ID`,
      params
    );
    return NextResponse.json(rows);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ status: "failed", message: msg }, { status: 503 });
  }
}
