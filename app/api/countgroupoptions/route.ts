import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getPool } from "@/lib/aurora";
import type { RowDataPacket } from "mysql2/promise";

// Legacy: key + option + optional from/to (group resolved from key's dealer group).
// New: JWT + option + optional from/to; group resolved from dealer_dim.DEALER_GROUP.

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const { searchParams } = req.nextUrl;
  const option = searchParams.get("option") ?? "";
  if (!option) {
    return NextResponse.json({ status: "failed", message: "API Key, Username, Option required." }, { status: 422 });
  }
  if (!claims.dealer_id) {
    return NextResponse.json({ status: "failed", message: "No dealer assigned." }, { status: 403 });
  }

  const from = searchParams.get("from") ?? null;
  const to   = searchParams.get("to") ?? null;

  try {
    const pool = getPool();

    // Find this dealer's group name
    const [groupRows] = await pool.query<RowDataPacket[]>(
      "SELECT DEALER_GROUP FROM dealer_dim WHERE DEALER_ID = ? LIMIT 1",
      [claims.dealer_id]
    );
    if (!groupRows.length || !groupRows[0].DEALER_GROUP) {
      return NextResponse.json({ option, total_count: 0 });
    }
    const dealerGroup = groupRows[0].DEALER_GROUP as string;

    // Count options across all dealers in the same group
    const conditions = [
      "a.DEALER_ID IN (SELECT DEALER_ID FROM dealer_dim WHERE DEALER_GROUP = ?)",
      "a.ITEM_NAME = ?",
    ];
    const params: unknown[] = [dealerGroup, option];
    if (from) { conditions.push("a.CREATION_DATE >= ?"); params.push(from); }
    if (to)   { conditions.push("a.CREATION_DATE <= ?"); params.push(to); }

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) as total_count FROM addendum_data a WHERE ${conditions.join(" AND ")}`,
      params
    );
    const total = (rows[0] as unknown as { total_count: number }).total_count;
    return NextResponse.json({ option, total_count: total });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ status: "failed", message: msg }, { status: 503 });
  }
}
