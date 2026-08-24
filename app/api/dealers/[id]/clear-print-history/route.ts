import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { VehicleAuditLogInsert } from "@/lib/db";
import { authorizeDealerAction } from "@/lib/dealer-authz";

// PostgREST encodes `.in("col", ids)` into the request URL. A large id list
// (~1,000 UUIDs ≈ 37 KB) overflows the proxy's request-URI limit and is rejected
// before reaching Postgres — surfacing as a supabase error with an EMPTY message,
// which this route turned into a 500 (the bug: a big lot like Dickson, 1,799
// active). Chunk every id-list op so the URL stays small (~150 UUIDs ≈ 5.5 KB).
const ID_CHUNK = 150;
// PostgREST also caps a plain select at db-max-rows (1,000), so the active-id
// fetch must paginate or it silently misses everything past the first 1,000.
const SELECT_PAGE = 1000;
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * POST /api/dealers/[dealerId]/clear-print-history
 * Deletes print_history and addendum_data for active vehicles of a dealer.
 * dealer_admin: own dealer. super_admin: any. group_admin: a dealer in their group
 * (the member dealer they're switched into).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const dealerId = params.id;
  if (!dealerId) return NextResponse.json({ error: "dealerId required" }, { status: 400 });

  // dealer_admin/dealer_user → own; group_admin → in-group; super_admin → any.
  const authz = await authorizeDealerAction(claims, dealerId);
  if (!authz.ok) return authz.response;

  const admin = createAdminSupabaseClient();

  // Fetch ALL active vehicle IDs for this dealer — paginated past the 1,000-row
  // PostgREST cap so a large lot resets fully (not just its first 1,000).
  const activeIds: string[] = [];
  for (let from = 0; ; from += SELECT_PAGE) {
    const { data, error: vErr } = await admin
      .from("dealer_vehicles")
      .select("id")
      .eq("dealer_id", dealerId)
      .eq("status", "active")
      .range(from, from + SELECT_PAGE - 1);
    if (vErr) return NextResponse.json({ error: vErr.message || "Failed to load active vehicles" }, { status: 500 });
    if (!data || data.length === 0) break;
    activeIds.push(...data.map(v => v.id as string));
    if (data.length < SELECT_PAGE) break;
  }
  if (activeIds.length === 0) {
    return NextResponse.json({ cleared_vehicles: 0 });
  }

  // Resolve dealer UUID up front (needed for the addendum_data FK).
  const { data: dealerRow } = await admin
    .from("dealers")
    .select("id")
    .eq("dealer_id", dealerId)
    .maybeSingle<{ id: string }>();

  // Delete print_history for active vehicles — chunked so the id list never
  // overflows the request URI.
  for (const ids of chunk(activeIds, ID_CHUNK)) {
    const { error: phErr } = await admin
      .from("print_history")
      .delete()
      .eq("dealer_id", dealerId)
      .in("vehicle_id", ids);
    if (phErr) return NextResponse.json({ error: phErr.message || "Failed to clear print history" }, { status: 500 });
  }

  // Reset canonical print fields on dealer_vehicles — dashboard counts, the
  // print-status filter, and the Create Document button states read from these.
  // Scope directly by dealer + active status (no id list needed → no URL limit).
  // print_cleared_at (migration 140) records the deliberate clear so ETL Job 6
  // doesn't re-mark from Aurora that night unless 4.0 shows a NEWER print;
  // tolerant of the column not existing yet (retry without it).
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
    .eq("dealer_id", dealerId)
    .eq("status", "active");
  if (dvResetErr && /print_cleared_at|options_saved_at/.test(dvResetErr.message)) {
    console.warn("[clear-print-history] print_cleared_at column missing (apply migration 140) — clearing without the Job-6 guard stamp");
    ({ error: dvResetErr } = await admin
      .from("dealer_vehicles")
      .update(baseReset)
      .eq("dealer_id", dealerId)
      .eq("status", "active"));
  }
  if (dvResetErr) console.error("[clear-print-history] dealer_vehicles reset failed:", dvResetErr.message);

  // Delete addendum_data for active vehicles — needs dealer UUID for FK. Chunked.
  if (dealerRow?.id) {
    for (const ids of chunk(activeIds, ID_CHUNK)) {
      const { error: adErr } = await admin
        .from("addendum_data")
        .delete()
        .eq("dealer_id", dealerRow.id)
        .in("vehicle_id", ids);
      if (adErr) console.error("[clear-print-history] addendum_data delete failed:", adErr.message);
    }
  }

  // Clear saved per-vehicle option overrides (requires migration 037). Chunked.
  // The dealer's Options Library (addendum_library) is NOT affected.
  for (const ids of chunk(activeIds, ID_CHUNK)) {
    const { error: voErr } = await admin
      .from("vehicle_options")
      .delete()
      .eq("dealer_id", dealerId)
      .in("vehicle_id", ids);
    if (voErr) console.error("[clear-print-history] vehicle_options delete failed:", voErr.message);
  }
  // Always delete the legacy '0' sentinel row (dealer-wide shared override).
  // The per-dealer route owns this; the bulk route deliberately does NOT.
  await admin
    .from("vehicle_options")
    .delete()
    .eq("dealer_id", dealerId)
    .eq("vehicle_id", "0");

  // Log to vehicle_audit_log for each affected vehicle. Insert is body-based, but
  // chunk it too to keep payloads modest on big lots.
  for (const ids of chunk(activeIds, ID_CHUNK)) {
    const logRows: VehicleAuditLogInsert[] = ids.map(vid => ({
      dealer_id: dealerId,
      vehicle_id: vid,
      action: "print_history_cleared" as const,
      method: "manual",
      changed_by: claims.sub,
    }));
    const { error: auditErr } = await admin.from("vehicle_audit_log").insert(logRows);
    // Pre-migration-140 the action CHECK rejected 'print_history_cleared' —
    // surface instead of swallowing (the clear itself already succeeded).
    if (auditErr) console.error("[clear-print-history] audit insert failed:", auditErr.message);
  }

  return NextResponse.json({ cleared_vehicles: activeIds.length });
}
