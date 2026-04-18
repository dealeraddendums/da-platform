import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getPool } from "@/lib/aurora";
import type { VehicleRowPacket } from "@/lib/aurora";
import { createAdminSupabaseClient } from "@/lib/db";

const PER_PAGE_DEFAULT = 50;
const PER_PAGE_MAX = 200;

/**
 * GET /api/vehicles
 * Query params:
 *   dealer_id — the text DEALER_ID from dealer_dim / vehicles (required for super_admin / group_admin)
 *   q         — search VIN, stock, make, model
 *   condition — new | used | cpo | all (default all)
 *   status    — active | all (default active)
 *   page      — 1-indexed
 *   per_page  — max 200
 *
 * Access control:
 *   dealer_admin / dealer_user — uses their own dealer's DEALER_ID (from profiles.dealer_id)
 *   group_admin / super_admin  — must pass dealer_id param
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const { searchParams } = req.nextUrl;
  const conditionParam = searchParams.get("condition") ?? "all";
  const statusParam = searchParams.get("status") ?? "active";
  const q = searchParams.get("q") ?? "";
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const perPage = Math.min(
    PER_PAGE_MAX,
    Math.max(1, parseInt(searchParams.get("per_page") ?? String(PER_PAGE_DEFAULT), 10))
  );

  // ── Resolve dealer_id ──────────────────────────────────────────────────────

  let dealerId: string | null = null;

  if (claims.role === "dealer_admin" || claims.role === "dealer_user") {
    // Their own dealer — look up legacy DEALER_ID from the dealers table
    if (!claims.dealer_id) {
      return NextResponse.json({ error: "No dealer assigned to your account" }, { status: 403 });
    }
    dealerId = claims.dealer_id; // profiles.dealer_id == vehicles.DEALER_ID
  } else {
    // super_admin or group_admin — dealer_id param required
    const paramDealerId = searchParams.get("dealer_id");
    if (!paramDealerId) {
      return NextResponse.json(
        { error: "dealer_id param is required for admin users" },
        { status: 400 }
      );
    }

    // group_admin: verify this dealer belongs to their group
    if (claims.role === "group_admin") {
      const admin = createAdminSupabaseClient();
      const { data: dealer } = await admin
        .from("dealers")
        .select("group_id, dealer_id")
        .eq("dealer_id", paramDealerId)
        .single();
      if (!dealer || dealer.group_id !== claims.group_id) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    dealerId = paramDealerId;
  }

  // ── Build query ────────────────────────────────────────────────────────────

  // TODO: verify this should use inventory_dealer_id (dealerId here comes from profiles.dealer_id via claims)
  const where: string[] = ["DEALER_ID = ?"];
  const params: (string | number)[] = [dealerId];

  if (statusParam === "active") {
    where.push("STATUS = '1'");
  }

  if (conditionParam === "new") {
    where.push("NEW_USED = 'New'", "CERTIFIED != 'Yes'");
  } else if (conditionParam === "used") {
    where.push("NEW_USED = 'Used'", "CERTIFIED != 'Yes'");
  } else if (conditionParam === "cpo") {
    where.push("CERTIFIED = 'Yes'");
  }

  if (q) {
    const like = `%${q}%`;
    where.push("(VIN_NUMBER LIKE ? OR STOCK_NUMBER LIKE ? OR MAKE LIKE ? OR MODEL LIKE ?)");
    params.push(like, like, like, like);
  }

  const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const offset = (page - 1) * perPage;

  const selectCols =
    "id, DEALER_ID, VIN_NUMBER, STOCK_NUMBER, YEAR, MAKE, MODEL, TRIM, BODYSTYLE, " +
    "EXT_COLOR, MILEAGE, MSRP, NEW_USED, CERTIFIED, STATUS, PRINT_STATUS, " +
    "DATE_IN_STOCK, PHOTOS, HMPG, CMPG, MPG";

  try {
    const pool = getPool();

    const [countRows] = await pool.query<VehicleRowPacket[]>(
      `SELECT COUNT(*) as cnt FROM vehicles ${whereSQL}`,
      params
    );
    const total = (countRows[0] as unknown as { cnt: number }).cnt;

    const [rows] = await pool.query<VehicleRowPacket[]>(
      `SELECT ${selectCols} FROM vehicles ${whereSQL} ORDER BY DATE_IN_STOCK DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, perPage, offset]
    );

    return NextResponse.json({
      data: rows,
      total,
      page,
      per_page: perPage,
      dealer_id: dealerId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Aurora connection failed";
    return NextResponse.json({ error: msg }, { status: 503 });
  }
}
