import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getPool } from "@/lib/aurora";
import type { RowDataPacket } from "mysql2/promise";

// Legacy: key + username. New: Supabase JWT.
// Returns list of dealer IDs and names scoped by role.

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  try {
    const pool = getPool();
    let rows: RowDataPacket[];

    if (claims.role === "super_admin") {
      const [r] = await pool.query<RowDataPacket[]>(
        "SELECT _ID, DEALER_ID, DEALER_NAME FROM dealer_dim WHERE ACTIVE = '1' ORDER BY DEALER_NAME"
      );
      rows = r;
    } else {
      if (!claims.dealer_id) {
        return NextResponse.json({ status: "failed", message: "No dealer assigned." }, { status: 403 });
      }
      const [r] = await pool.query<RowDataPacket[]>(
        "SELECT _ID, DEALER_ID, DEALER_NAME FROM dealer_dim WHERE DEALER_ID = ? LIMIT 1",
        [claims.dealer_id]
      );
      rows = r;
    }
    return NextResponse.json(rows);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ status: "failed", message: msg }, { status: 503 });
  }
}
