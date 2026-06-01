// POST /api/print/clear-history
//
// Bulk-scoped reset of print state + saved products for a selected set of
// vehicles. Mirrors app/api/dealers/[id]/clear-print-history (the per-dealer
// full reset) but scoped to the vehicle UUIDs the caller passed in.
//
// IMPORTANT — the per-dealer route also deletes the legacy
// `vehicle_id = '0'` sentinel from vehicle_options. That sentinel is a
// dealer-wide shared row, so the per-dealer route can safely wipe it
// because it's resetting the entire dealer. Here we are scoped to a
// subset — deleting the sentinel would wrongly clear saved products on
// NON-selected vehicles. The sentinel is intentionally untouched.
//
// Auth: dealer_admin / dealer_user → only their own dealer's vehicles.
// super_admin → any dealer. Every vehicleId must belong to one shared
// dealer; the route refuses mixed-dealer batches because the cascade
// needs a single dealer slug + UUID.

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { VehicleAuditLogInsert } from "@/lib/db";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  let body: { vehicleIds?: unknown };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rawIds = Array.isArray(body.vehicleIds) ? body.vehicleIds : [];
  const vehicleIds = rawIds.filter((v): v is string => typeof v === "string" && v.length > 0);
  if (vehicleIds.length === 0) {
    return NextResponse.json({ error: "vehicleIds required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // Resolve dealer slug from the selected rows so we can authorize, and so we
  // can prove every id is real (a missing row would silently no-op below).
  const { data: dvRows, error: dvErr } = await admin
    .from("dealer_vehicles")
    .select("id, dealer_id")
    .in("id", vehicleIds);
  if (dvErr) return NextResponse.json({ error: dvErr.message }, { status: 500 });

  const foundIds = (dvRows ?? []).map(r => r.id as string);
  if (foundIds.length !== vehicleIds.length) {
    return NextResponse.json({ error: "One or more vehicleIds not found" }, { status: 404 });
  }

  const dealerSlugs = new Set((dvRows ?? []).map(r => r.dealer_id as string));
  if (dealerSlugs.size !== 1) {
    return NextResponse.json({ error: "Selection spans multiple dealers" }, { status: 400 });
  }
  const dealerSlug = Array.from(dealerSlugs)[0];

  if (claims.role === "dealer_admin" || claims.role === "dealer_user") {
    if (claims.dealer_id !== dealerSlug) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else if (claims.role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ── Delete print_history (scoped to selected vehicleIds) ─────────────────
  const { error: phErr } = await admin
    .from("print_history")
    .delete()
    .eq("dealer_id", dealerSlug)
    .in("vehicle_id", vehicleIds);
  if (phErr) return NextResponse.json({ error: phErr.message }, { status: 500 });

  // ── Reset canonical print fields on dealer_vehicles ─────────────────────
  const { error: dvResetErr } = await admin
    .from("dealer_vehicles")
    .update({ print_status: 0, print_info: 0, print_guide: 0, print_date: null, print_user: null })
    .eq("dealer_id", dealerSlug)
    .in("id", vehicleIds);
  if (dvResetErr) console.error("[print/clear-history] dealer_vehicles reset failed:", dvResetErr.message);

  // ── Delete addendum_data (needs dealer UUID for FK) ─────────────────────
  const { data: dealerRow } = await admin
    .from("dealers")
    .select("id")
    .eq("dealer_id", dealerSlug)
    .maybeSingle<{ id: string }>();
  if (dealerRow?.id) {
    await admin
      .from("addendum_data")
      .delete()
      .eq("dealer_id", dealerRow.id)
      .in("vehicle_id", vehicleIds);
  }

  // ── Delete saved option overrides — selected ids ONLY ────────────────────
  // Deliberately do NOT delete the legacy vehicle_id='0' sentinel here. See
  // the file header comment.
  await admin
    .from("vehicle_options")
    .delete()
    .eq("dealer_id", dealerSlug)
    .in("vehicle_id", vehicleIds);

  // ── Audit log (one row per cleared vehicle) ─────────────────────────────
  const logRows: VehicleAuditLogInsert[] = vehicleIds.map(vid => ({
    dealer_id: dealerSlug,
    vehicle_id: vid,
    action: "print_history_cleared" as const,
    method: "manual",
    changed_by: claims.sub,
  }));
  if (logRows.length > 0) {
    await admin.from("vehicle_audit_log").insert(logRows);
  }

  return NextResponse.json({ cleared_vehicles: vehicleIds.length });
}
