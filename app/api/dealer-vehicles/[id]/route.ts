import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerVehicleInsert, DealerVehicleRow, VehicleAuditLogInsert } from "@/lib/db";

type Params = { params: { id: string } };

function dealerGuard(claims: { role: string; dealer_id: string | null; impersonating_dealer_id: string | null }) {
  const isAdmin = (claims.role === "super_admin" || claims.role === "group_admin") && !claims.impersonating_dealer_id;
  const dealerId = claims.impersonating_dealer_id ?? claims.dealer_id;
  return { isAdmin, dealerId };
}

/** GET /api/dealer-vehicles/[id] — fetch a single manual vehicle */
export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const { isAdmin, dealerId } = dealerGuard(claims);
  if (isAdmin) return NextResponse.json({ error: "Not available for admin roles" }, { status: 403 });
  if (!dealerId) return NextResponse.json({ error: "No dealer assigned" }, { status: 403 });

  const admin = createAdminSupabaseClient();
  const { data, error: dbErr } = await admin
    .from("dealer_vehicles")
    .select("*")
    .eq("id", params.id)
    .eq("dealer_id", dealerId)
    .single();

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 404 });
  return NextResponse.json(data);
}

/** PATCH /api/dealer-vehicles/[id] — update vehicle fields + audit log */
export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const { isAdmin, dealerId } = dealerGuard(claims);
  if (isAdmin) return NextResponse.json({ error: "Not available for admin roles" }, { status: 403 });
  if (!dealerId) return NextResponse.json({ error: "No dealer assigned" }, { status: 403 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  const { data: current, error: fetchErr } = await admin
    .from("dealer_vehicles")
    .select("*")
    .eq("id", params.id)
    .eq("dealer_id", dealerId)
    .single();

  if (fetchErr || !current) return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });

  const EDITABLE: (keyof DealerVehicleInsert)[] = [
    "stock_number", "vin", "year", "make", "model", "trim",
    "body_style", "exterior_color", "interior_color", "engine",
    "transmission", "drivetrain", "mileage", "msrp", "condition", "status",
    "description", "options",
  ];

  const update: Record<string, unknown> = {};
  const changes: Record<string, { old: unknown; new: unknown }> = {};

  for (const field of EDITABLE) {
    if (!(field in body)) continue;
    const oldVal = (current as Record<string, unknown>)[field];
    const newVal = body[field];
    if (String(oldVal ?? "") !== String(newVal ?? "")) {
      update[field] = newVal;
      changes[field] = { old: oldVal ?? null, new: newVal ?? null };
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json(current);
  }

  const { data: updated, error: updateErr } = await admin
    .from("dealer_vehicles")
    .update(update as Partial<Omit<DealerVehicleRow, "id" | "dealer_id" | "date_added">>)
    .eq("id", params.id)
    .eq("dealer_id", dealerId)
    .select()
    .single();

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  const logEntry: VehicleAuditLogInsert = {
    dealer_id: dealerId,
    vehicle_id: params.id,
    stock_number: current.stock_number,
    action: "edit",
    method: "edit",
    changed_by: claims.sub,
    changed_by_email: claims.email,
    changes,
  };
  void admin.from("vehicle_audit_log").insert(logEntry);

  return NextResponse.json(updated);
}

/** DELETE /api/dealer-vehicles/[id] — delete a single vehicle */
export async function DELETE(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const { isAdmin, dealerId } = dealerGuard(claims);
  if (isAdmin) return NextResponse.json({ error: "Not available for admin roles" }, { status: 403 });
  if (!dealerId) return NextResponse.json({ error: "No dealer assigned" }, { status: 403 });

  const admin = createAdminSupabaseClient();

  const { data: vehicle } = await admin
    .from("dealer_vehicles")
    .select("stock_number")
    .eq("id", params.id)
    .eq("dealer_id", dealerId)
    .single();

  if (!vehicle) return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });

  const logEntry: VehicleAuditLogInsert = {
    dealer_id: dealerId,
    vehicle_id: params.id,
    stock_number: vehicle.stock_number,
    action: "delete",
    changed_by: claims.sub,
    changed_by_email: claims.email,
  };
  void admin.from("vehicle_audit_log").insert(logEntry);

  const { error: delErr } = await admin
    .from("dealer_vehicles")
    .delete()
    .eq("id", params.id)
    .eq("dealer_id", dealerId);

  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });
  return NextResponse.json({ deleted: true });
}
