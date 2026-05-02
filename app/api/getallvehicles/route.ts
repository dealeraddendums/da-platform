import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

// Legacy: required key + username + optional dealer + optional type.
// New: Supabase JWT; dealer scoped by role; pass ?dealer= to override (super_admin only).
// Data source: Supabase dealer_vehicles

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const { searchParams } = req.nextUrl;

  let dealerId: string | null = null;
  if (claims.role === "dealer_admin" || claims.role === "dealer_user") {
    dealerId = claims.dealer_id;
  } else {
    dealerId = searchParams.get("dealer") ?? null;
  }

  if (!dealerId) {
    return NextResponse.json({ status: "failed", message: "API Key, Username required." }, { status: 422 });
  }

  const admin = createAdminSupabaseClient();
  const { data: rows, error: dbErr } = await admin
    .from("dealer_vehicles")
    .select("dealer_id, vin, stock_number, year, make, model, body_style, trim, exterior_color, interior_color, engine, drivetrain, transmission, mileage, date_added, msrp, condition, status")
    .eq("dealer_id", dealerId)
    .eq("status", "active")
    .order("date_added", { ascending: false, nullsFirst: false });

  if (dbErr) {
    return NextResponse.json({ status: "failed", message: dbErr.message }, { status: 500 });
  }

  // Map to legacy column names for backward compat
  const mapped = (rows ?? []).map((r) => ({
    DEALER_ID: r.dealer_id,
    VIN_NUMBER: r.vin,
    STOCK_NUMBER: r.stock_number,
    YEAR: r.year ? String(r.year) : null,
    MAKE: r.make,
    MODEL: r.model,
    BODYSTYLE: r.body_style,
    TRIM: r.trim,
    EXT_COLOR: r.exterior_color,
    INT_COLOR: r.interior_color,
    ENGINE: r.engine,
    DRIVETRAIN: r.drivetrain,
    TRANSMISSION: r.transmission,
    MILEAGE: r.mileage ? String(r.mileage) : null,
    DATE_IN_STOCK: r.date_added,
    MSRP: r.msrp ? String(r.msrp) : null,
    NEW_USED: r.condition === "Used" ? "Used" : "New",
    STATUS: r.status === "active" ? "1" : "0",
  }));

  return NextResponse.json(mapped);
}
