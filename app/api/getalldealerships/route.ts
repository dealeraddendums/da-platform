import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getPool } from "@/lib/aurora";
import type { RowDataPacket } from "mysql2/promise";

// Legacy: required key + username. New: Supabase JWT.
// super_admin gets all; group_admin gets their group; dealer_admin gets own.

const COLS = "ACTIVE, OWNER, DEALER_GROUP, DEALER_ID, DEALER_NAME, PRIMARY_CONTACT, PRIMARY_CONTACT_EMAIL, DEALER_ADDRESS, DEALER_CITY, DEALER_STATE, DEALER_ZIP, DEALER_COUNTRY, DEALER_PHONE, BILLING_DATE, ACCOUNT_TYPE, FEED_SOURCE, REFERRED_BY";

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  try {
    const pool = getPool();
    let rows: RowDataPacket[];

    if (claims.role === "super_admin") {
      const [r] = await pool.query<RowDataPacket[]>(`SELECT ${COLS} FROM dealer_dim ORDER BY DEALER_NAME`);
      rows = r;
    } else if (claims.role === "group_admin" && claims.group_id) {
      // Find group name from Supabase groups via dealer_dim DEALER_GROUP field
      // Simpler: get dealers where DEALER_GROUP matches the group_admin's dealers
      const [r] = await pool.query<RowDataPacket[]>(
        `SELECT ${COLS} FROM dealer_dim WHERE DEALER_ID IN (
          SELECT DEALER_ID FROM dealer_dim WHERE DEALER_GROUP = (
            SELECT DEALER_GROUP FROM dealer_dim WHERE DEALER_ID = ? LIMIT 1
          )
        ) ORDER BY DEALER_NAME`,
        [claims.dealer_id ?? ""]
      );
      rows = r;
    } else {
      if (!claims.dealer_id) {
        return NextResponse.json({ status: "failed", message: "No dealer assigned." }, { status: 403 });
      }
      const [r] = await pool.query<RowDataPacket[]>(
        `SELECT ${COLS} FROM dealer_dim WHERE DEALER_ID = ? LIMIT 1`,
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
