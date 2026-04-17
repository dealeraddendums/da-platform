import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getPool } from "@/lib/aurora";
import type { RowDataPacket } from "mysql2/promise";

// Legacy: required key (resolves dealer_id from KeyOwner), optional from/to dates.
// New: Supabase JWT; dealer_id from claims.

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (!claims.dealer_id) {
    return NextResponse.json({ status: "failed", message: "No dealer assigned." }, { status: 403 });
  }

  const { searchParams } = req.nextUrl;
  const from = searchParams.get("from") ?? null;
  const to = searchParams.get("to") ?? null;

  try {
    const pool = getPool();
    const conditions = ["DEALER_ID = ?"];
    const params: unknown[] = [claims.dealer_id];

    if (from) { conditions.push("CREATION_DATE >= ?"); params.push(from); }
    if (to)   { conditions.push("CREATION_DATE <= ?"); params.push(to); }

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT _ID, VEHICLE_ID, ITEM_NAME, ITEM_DESCRIPTION, ITEM_PRICE, ACTIVE, DEALER_ID, CREATION_DATE, VIN_NUMBER FROM addendum_data WHERE ${conditions.join(" AND ")} ORDER BY CREATION_DATE DESC`,
      params
    );
    return NextResponse.json(rows);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ status: "failed", message: msg }, { status: 503 });
  }
}
