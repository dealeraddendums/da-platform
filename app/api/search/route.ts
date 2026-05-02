import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

// Legacy: required key + username + vin. New: Supabase JWT + vin.
// dealer_admin/user scoped to own dealer; super_admin can pass dealership_id param.
// Data source: Supabase dealer_vehicles

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const { searchParams } = req.nextUrl;
  const vin = searchParams.get("vin") ?? "";
  if (!vin) {
    return NextResponse.json({ status: "failed", message: "API Key, Username, VIN required." }, { status: 422 });
  }

  // Resolve dealer scope
  let dealerId: string | null = null;
  if (claims.role === "dealer_admin" || claims.role === "dealer_user") {
    dealerId = claims.dealer_id;
  } else {
    dealerId = searchParams.get("dealership_id") ?? null;
  }

  const admin = createAdminSupabaseClient();

  let query = admin
    .from("dealer_vehicles")
    .select("dealer_id, vin, stock_number, year, make, model, body_style, trim, exterior_color, interior_color, engine, drivetrain, transmission, mileage, date_added, msrp, condition, status")
    .eq("vin", vin.toUpperCase())
    .limit(1);

  if (dealerId) {
    query = query.eq("dealer_id", dealerId) as typeof query;
  }

  const { data, error: dbErr } = await query.maybeSingle();

  if (dbErr) {
    return NextResponse.json({ status: "failed", message: dbErr.message }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({ status: "failed", message: "VIN Not Found." }, { status: 422 });
  }

  return NextResponse.json({
    DEALER_ID: data.dealer_id,
    VIN_NUMBER: data.vin,
    STOCK_NUMBER: data.stock_number,
    YEAR: data.year ? String(data.year) : null,
    MAKE: data.make,
    MODEL: data.model,
    BODYSTYLE: data.body_style,
    TRIM: data.trim,
    EXT_COLOR: data.exterior_color,
    INT_COLOR: data.interior_color,
    ENGINE: data.engine,
    DRIVETRAIN: data.drivetrain,
    TRANSMISSION: data.transmission,
    MILEAGE: data.mileage ? String(data.mileage) : null,
    DATE_IN_STOCK: data.date_added,
    MSRP: data.msrp ? String(data.msrp) : null,
    NEW_USED: data.condition === "Used" ? "Used" : "New",
    STATUS: data.status === "active" ? "1" : "0",
    PRINT_STATUS: null,
    PRINT_DATE: null,
    INPUT_DATE: data.date_added,
  });
}
