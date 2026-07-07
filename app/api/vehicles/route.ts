import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

const PER_PAGE_DEFAULT = 50;
const PER_PAGE_MAX = 200;

/**
 * GET /api/vehicles
 * Query params:
 *   dealer_id — the text DEALER_ID (required for super_admin / group_admin)
 *   q         — search VIN, stock, make, model
 *   condition — new | used | cpo | all (default all)
 *   status    — active | all (default active)
 *   page      — 1-indexed
 *   per_page  — max 200
 *
 * Data source: Supabase dealer_vehicles
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
    if (!claims.dealer_id) {
      return NextResponse.json({ error: "No dealer assigned to your account" }, { status: 403 });
    }
    dealerId = claims.dealer_id;
  } else {
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

  // ── Build Supabase query ───────────────────────────────────────────────────

  try {
    const admin = createAdminSupabaseClient();
    const from = (page - 1) * perPage;

    let query = admin
      .from("dealer_vehicles")
      .select(
        "id, dealer_id, vin, stock_number, year, make, model, trim, body_style, exterior_color, mileage, msrp, condition, status, date_added, print_queue",
        { count: "exact" }
      )
      .eq("dealer_id", dealerId);

    if (statusParam === "active") {
      query = query.eq("status", "active");
    }

    if (conditionParam === "new") {
      query = query.eq("condition", "New");
    } else if (conditionParam === "used") {
      query = query.eq("condition", "Used");
    } else if (conditionParam === "cpo") {
      query = query.eq("condition", "CPO");
    }

    if (q) {
      query = query.or(`vin.ilike.%${q}%,stock_number.ilike.%${q}%,make.ilike.%${q}%,model.ilike.%${q}%`);
    }

    const { data: rows, error: dbErr, count } = await query
      .order("date_added", { ascending: false, nullsFirst: false })
      .range(from, from + perPage - 1);

    if (dbErr) {
      return NextResponse.json({ error: dbErr.message }, { status: 500 });
    }

    const total = count ?? 0;

    // Determine printed state from Supabase print_history
    const vehicleIds = (rows ?? []).map((r) => r.id as string);
    let printedSet = new Set<string>();
    if (vehicleIds.length > 0) {
      const { data: printedRows } = await admin
        .from("print_history")
        .select("vehicle_id")
        .eq("dealer_id", dealerId)
        .in("vehicle_id", vehicleIds);
      for (const r of printedRows ?? []) {
        printedSet.add(String(r.vehicle_id));
      }
    }

    const enriched = (rows ?? []).map((r) => ({
      ...r,
      // Legacy field names for backward compat
      DEALER_ID: r.dealer_id,
      VIN_NUMBER: r.vin,
      STOCK_NUMBER: r.stock_number,
      YEAR: r.year ? String(r.year) : null,
      MAKE: r.make,
      MODEL: r.model,
      TRIM: r.trim,
      BODYSTYLE: r.body_style,
      EXT_COLOR: r.exterior_color,
      MILEAGE: r.mileage ? String(r.mileage) : null,
      MSRP: r.msrp ? String(r.msrp) : null,
      NEW_USED: r.condition === "Used" ? "Used" : "New",
      CERTIFIED: r.condition === "CPO" ? "Yes" : "No",
      STATUS: r.status === "active" ? "1" : "0",
      DATE_IN_STOCK: r.date_added,
      supabase_printed: printedSet.has(r.id as string),
    }));

    return NextResponse.json({
      data: enriched,
      total,
      page,
      per_page: perPage,
      dealer_id: dealerId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Query failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
