import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getPool } from "@/lib/aurora";
import type { RowDataPacket } from "mysql2/promise";

// Legacy: key + option + optional from/to. New: JWT + option + optional from/to.
// Returns how many times a specific option name appears for the dealer's vehicles.

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
    const conditions = ["DEALER_ID = ?", "ITEM_NAME = ?"];
    const params: unknown[] = [claims.dealer_id, option];

    if (from) { conditions.push("CREATION_DATE >= ?"); params.push(from); }
    if (to)   { conditions.push("CREATION_DATE <= ?"); params.push(to); }

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) as total_count FROM addendum_data WHERE ${conditions.join(" AND ")}`,
      params
    );
    const total = (rows[0] as unknown as { total_count: number }).total_count;
    return NextResponse.json({ option, total_count: total });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ status: "failed", message: msg }, { status: 503 });
  }
}
