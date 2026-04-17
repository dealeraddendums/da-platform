import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getPool } from "@/lib/aurora";
import type { RowDataPacket } from "mysql2/promise";

// Legacy: required key (resolves dealer_id). New: Supabase JWT.

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (!claims.dealer_id) {
    return NextResponse.json({ status: "failed", message: "No dealer assigned." }, { status: 403 });
  }

  try {
    const pool = getPool();
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT DEALER_ID, ITEM_NAME, ITEM_DESCRIPTION, ITEM_PRICE, MODELS, TRIMS, BODY_STYLES, created_at FROM addendum_defaults WHERE DEALER_ID = ? ORDER BY RE_ORDER, _ID",
      [claims.dealer_id]
    );
    return NextResponse.json(rows);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ status: "failed", message: msg }, { status: 503 });
  }
}
