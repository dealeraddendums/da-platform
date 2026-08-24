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

// PostgREST encodes `.in("col", ids)` into the request URL; a large id list
// (~1,000 UUIDs ≈ 37 KB) overflows the proxy's request-URI limit and 500s. Chunk
// every id-list op so the URL stays small (~150 UUIDs ≈ 5.5 KB). A select-all of
// a big lot can pass hundreds/thousands of ids here.
const ID_CHUNK = 150;
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

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
  // Chunked so a large selection doesn't overflow the request URI.
  const dvRows: { id: string; dealer_id: string }[] = [];
  for (const ids of chunk(vehicleIds, ID_CHUNK)) {
    const { data, error: dvErr } = await admin
      .from("dealer_vehicles")
      .select("id, dealer_id")
      .in("id", ids);
    if (dvErr) return NextResponse.json({ error: dvErr.message || "Failed to resolve vehicles" }, { status: 500 });
    dvRows.push(...((data ?? []) as { id: string; dealer_id: string }[]));
  }

  const foundIds = dvRows.map(r => r.id);
  if (foundIds.length !== vehicleIds.length) {
    return NextResponse.json({ error: "One or more vehicleIds not found" }, { status: 404 });
  }

  const dealerSlugs = new Set(dvRows.map(r => r.dealer_id));
  if (dealerSlugs.size !== 1) {
    return NextResponse.json({ error: "Selection spans multiple dealers" }, { status: 400 });
  }
  const dealerSlug = Array.from(dealerSlugs)[0];

  // Dealer roles and a group_admin acting as a dealer are scoped to their own
  // dealer (group_admin's claims.dealer_id is the active dealer; null otherwise).
  if (claims.role === "dealer_admin" || claims.role === "dealer_user" || claims.role === "group_admin") {
    if (claims.dealer_id !== dealerSlug) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else if (claims.role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Resolve dealer UUID once (needed for the addendum_data FK).
  const { data: dealerRow } = await admin
    .from("dealers")
    .select("id")
    .eq("dealer_id", dealerSlug)
    .maybeSingle<{ id: string }>();

  // All id-scoped ops below are chunked so a large selection stays under the URI
  // limit. Every op stays scoped to the SELECTED vehicleIds (a subset) — so the
  // dealer_vehicles reset keeps its `.in("id", …)` (we must NOT touch unselected
  // rows), unlike the per-dealer route which resets all-active directly.
  for (const ids of chunk(vehicleIds, ID_CHUNK)) {
    // print_history
    const { error: phErr } = await admin
      .from("print_history")
      .delete()
      .eq("dealer_id", dealerSlug)
      .in("vehicle_id", ids);
    if (phErr) return NextResponse.json({ error: phErr.message || "Failed to clear print history" }, { status: 500 });

    // canonical print fields on dealer_vehicles (selected ids only).
    // print_cleared_at (migration 140) records the deliberate clear so ETL
    // Job 6 doesn't re-mark the vehicle from Aurora that night unless 4.0
    // shows a NEWER print. Tolerant of the column not existing yet (retry
    // without it) so the clear itself never breaks pre-migration.
    // options_saved_at → NULL restores the never-saved state: the clear also
    // deletes the vehicle's saved products below, and leaving the migration-148
    // explicit-save marker in place classified the vehicle as "saved empty" —
    // suppressing the all-vehicle library auto-apply in the editor AND on print
    // (Burns Honda CR-V, 2026-08-24). Cleared must equal never-printed.
    const baseReset = { print_status: 0, print_info: 0, print_guide: 0, print_date: null, print_user: null };
    const resetFields = { ...baseReset, options_saved_at: null };
    let { error: dvResetErr } = await admin
      .from("dealer_vehicles")
      .update({ ...resetFields, print_cleared_at: new Date().toISOString() })
      .eq("dealer_id", dealerSlug)
      .in("id", ids);
    if (dvResetErr && /print_cleared_at|options_saved_at/.test(dvResetErr.message)) {
      console.warn("[print/clear-history] print_cleared_at column missing (apply migration 140) — clearing without the Job-6 guard stamp");
      ({ error: dvResetErr } = await admin
        .from("dealer_vehicles")
        .update(baseReset)
        .eq("dealer_id", dealerSlug)
        .in("id", ids));
    }
    if (dvResetErr) console.error("[print/clear-history] dealer_vehicles reset failed:", dvResetErr.message);

    // addendum_data (needs dealer UUID for FK)
    if (dealerRow?.id) {
      const { error: adErr } = await admin
        .from("addendum_data")
        .delete()
        .eq("dealer_id", dealerRow.id)
        .in("vehicle_id", ids);
      if (adErr) console.error("[print/clear-history] addendum_data delete failed:", adErr.message);
    }

    // saved option overrides — selected ids ONLY. The legacy vehicle_id='0'
    // sentinel is dealer-wide shared state and is deliberately NOT touched here
    // (see file header).
    const { error: voErr } = await admin
      .from("vehicle_options")
      .delete()
      .eq("dealer_id", dealerSlug)
      .in("vehicle_id", ids);
    if (voErr) console.error("[print/clear-history] vehicle_options delete failed:", voErr.message);

    // audit log (one row per cleared vehicle)
    const logRows: VehicleAuditLogInsert[] = ids.map(vid => ({
      dealer_id: dealerSlug,
      vehicle_id: vid,
      action: "print_history_cleared" as const,
      method: "manual",
      changed_by: claims.sub,
    }));
    const { error: auditErr } = await admin.from("vehicle_audit_log").insert(logRows);
    // Pre-migration-140 the action CHECK rejected 'print_history_cleared' —
    // surface instead of swallowing (the clear itself already succeeded).
    if (auditErr) console.error("[print/clear-history] audit insert failed:", auditErr.message);
  }

  return NextResponse.json({ cleared_vehicles: vehicleIds.length });
}
