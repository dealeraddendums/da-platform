import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerVehicleArchiveRow, VehicleAuditLogInsert } from "@/lib/db";

/**
 * GET /api/admin/vehicle-archive?dealer_id=X
 * Returns all archived vehicles for a dealer. super_admin only.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  void claims; // super_admin confirmed

  const dealerId = req.nextUrl.searchParams.get("dealer_id");
  if (!dealerId) {
    return NextResponse.json({ error: "dealer_id required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const { data, error: dbErr } = await admin
    .from("dealer_vehicles_archive")
    .select("*")
    .eq("dealer_id", dealerId)
    .order("archived_at", { ascending: false })
    .limit(500);

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}

/**
 * POST /api/admin/vehicle-archive
 * Body: { action: "restore", id: archiveId }
 * Restores an archived vehicle back to dealer_vehicles with status='inactive'.
 * super_admin only.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  let body: { action?: string; id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.action !== "restore" || !body.id) {
    return NextResponse.json({ error: "action='restore' and id required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // Fetch the archived vehicle
  const { data: archived, error: fetchErr } = await admin
    .from("dealer_vehicles_archive")
    .select("*")
    .eq("id", body.id)
    .single<DealerVehicleArchiveRow>();

  if (fetchErr || !archived) {
    return NextResponse.json({ error: "Archived vehicle not found" }, { status: 404 });
  }

  // Guard: stock_number must not conflict with existing active inventory
  const { data: conflict } = await admin
    .from("dealer_vehicles")
    .select("id")
    .eq("dealer_id", archived.dealer_id)
    .eq("stock_number", archived.stock_number)
    .maybeSingle();

  if (conflict) {
    return NextResponse.json(
      { error: `Stock number "${archived.stock_number}" already exists in active inventory` },
      { status: 409 }
    );
  }

  // Restore: insert back into dealer_vehicles (new UUID auto-generated) with status=inactive.
  // Explicitly map fields to satisfy the typed Insert shape.
  const a = archived;
  const { data: restored, error: restoreErr } = await admin
    .from("dealer_vehicles")
    .insert({
      dealer_id: a.dealer_id, stock_number: a.stock_number,
      vin: a.vin, year: a.year, make: a.make, model: a.model, trim: a.trim,
      body_style: a.body_style, exterior_color: a.exterior_color, interior_color: a.interior_color,
      engine: a.engine, transmission: a.transmission, drivetrain: a.drivetrain,
      mileage: a.mileage, msrp: a.msrp, condition: a.condition, status: "inactive",
      decode_source: a.decode_source, decode_flagged: a.decode_flagged,
      description: a.description, options: a.options, created_by: a.created_by,
      doors: a.doors, fuel: a.fuel, photos: a.photos, date_in_stock: a.date_in_stock,
      vdp_link: a.vdp_link, status_code: a.status_code, warranty_expires: a.warranty_expires,
      insp_numb: a.insp_numb, msrp_adjustment: a.msrp_adjustment, discounted_price: a.discounted_price,
      internet_price: a.internet_price, cdjr_price: a.cdjr_price, certified: a.certified,
      hmpg: a.hmpg, cmpg: a.cmpg, mpg: a.mpg,
      print_status: a.print_status, print_date: a.print_date, print_guide: a.print_guide,
      print_info: a.print_info, print_queue: a.print_queue, print_user: a.print_user,
      print_flag: a.print_flag, print_sms: a.print_sms, options_added: a.options_added,
      re_order: a.re_order, edit_status: a.edit_status, edit_date: a.edit_date, input_date: a.input_date,
    })
    .select()
    .single();

  if (restoreErr) {
    return NextResponse.json({ error: restoreErr.message }, { status: 500 });
  }

  // Log restore event in vehicle_audit_log
  const logEntry: VehicleAuditLogInsert = {
    dealer_id: archived.dealer_id,
    vehicle_id: restored.id,
    stock_number: archived.stock_number,
    action: "restored_from_archive",
    method: "manual",
    changed_by: claims.sub,
    changed_by_email: claims.email,
  };
  const { error: logErr } = await admin.from("vehicle_audit_log").insert(logEntry);
  if (logErr) console.error("[vehicle-archive restore] audit log failed:", logErr.message);

  // Remove from archive
  const { error: archiveDeleteErr } = await admin
    .from("dealer_vehicles_archive")
    .delete()
    .eq("id", body.id);
  if (archiveDeleteErr) {
    console.error("[vehicle-archive restore] archive delete failed:", archiveDeleteErr.message);
  }

  return NextResponse.json({ vehicle: restored });
}
