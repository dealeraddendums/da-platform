import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerVehicleInsert } from "@/lib/db";

const PER_PAGE = 50;

/**
 * GET /api/dealer-vehicles?dealer_id=&page=&q=&condition=&status=
 * Returns paginated dealer_vehicles for a manual dealer.
 * Restricted to dealer_admin / dealer_user only.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (claims.role === "super_admin" || claims.role === "group_admin") {
    return NextResponse.json({ error: "Not available for admin roles" }, { status: 403 });
  }

  const dealerId = claims.dealer_id;
  if (!dealerId) {
    return NextResponse.json({ error: "No dealer assigned" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10));
  const q = sp.get("q") ?? "";
  const condition = sp.get("condition") ?? "all";
  const status = sp.get("status") ?? "active";
  const from = (page - 1) * PER_PAGE;
  const to = from + PER_PAGE - 1;

  const admin = createAdminSupabaseClient();
  let query = admin
    .from("dealer_vehicles")
    .select("*", { count: "exact" })
    .eq("dealer_id", dealerId)
    .order("date_added", { ascending: false })
    .range(from, to);

  if (status !== "all") query = query.eq("status", status);
  if (condition !== "all") query = query.ilike("condition", condition);
  if (q) {
    query = query.or(
      `stock_number.ilike.%${q}%,vin.ilike.%${q}%,make.ilike.%${q}%,model.ilike.%${q}%`
    );
  }

  const { data, count, error: dbErr } = await query;
  if (dbErr) {
    return NextResponse.json({ error: dbErr.message }, { status: 500 });
  }

  return NextResponse.json({
    data: data ?? [],
    total: count ?? 0,
    page,
    per_page: PER_PAGE,
    dealer_id: dealerId,
  });
}

/**
 * POST /api/dealer-vehicles
 * Creates a single vehicle record.
 * Restricted to dealer_admin / dealer_user only.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (claims.role === "super_admin" || claims.role === "group_admin") {
    return NextResponse.json({ error: "Not available for admin roles" }, { status: 403 });
  }

  const dealerId = claims.dealer_id;
  if (!dealerId) {
    return NextResponse.json({ error: "No dealer assigned" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const stockNumber = (body.stock_number as string | undefined)?.trim();
  if (!stockNumber) {
    return NextResponse.json({ error: "stock_number is required" }, { status: 422 });
  }

  const insert: DealerVehicleInsert = {
    dealer_id: dealerId,
    stock_number: stockNumber,
    vin: (body.vin as string | undefined)?.trim().toUpperCase() || null,
    year: body.year ? parseInt(String(body.year), 10) : null,
    make: (body.make as string | undefined)?.trim() || null,
    model: (body.model as string | undefined)?.trim() || null,
    trim: (body.trim as string | undefined)?.trim() || null,
    body_style: (body.body_style as string | undefined)?.trim() || null,
    exterior_color: (body.exterior_color as string | undefined)?.trim() || null,
    interior_color: (body.interior_color as string | undefined)?.trim() || null,
    engine: (body.engine as string | undefined)?.trim() || null,
    transmission: (body.transmission as string | undefined)?.trim() || null,
    drivetrain: (body.drivetrain as string | undefined)?.trim() || null,
    mileage: body.mileage ? parseInt(String(body.mileage), 10) : 0,
    msrp: body.msrp ? parseFloat(String(body.msrp)) : null,
    condition: (body.condition as string | undefined) || "New",
    status: "active",
    decode_source: (body.decode_source as string | undefined) || "manual",
    decode_flagged: Boolean(body.decode_flagged),
  };

  const admin = createAdminSupabaseClient();
  const { data, error: dbErr } = await admin
    .from("dealer_vehicles")
    .insert(insert)
    .select()
    .single();

  if (dbErr) {
    if (dbErr.code === "23505") {
      return NextResponse.json(
        { error: `Stock number "${stockNumber}" already exists for this dealer` },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: dbErr.message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}
