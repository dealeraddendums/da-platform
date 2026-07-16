import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient, fireWrite } from "@/lib/db";
import { authorizeDealerAction } from "@/lib/dealer-authz";

// POST /api/dealers/[id]/clear-manual-vehicles
//
// Mass-deactivates manually-added vehicles (VIN decoder / spreadsheet / lot
// app) for one dealer. Used when a dealer switches from manual entry to a
// live inventory feed — feeds only add/update, so the old manual rows would
// otherwise clog the dashboard as duplicates forever.
//
// "Manual" is identified two ways (surveyed prod 2026-07-16):
//   - created_by in the legacy 4.0 markers: 'VIN API' (decoder), 'EXCEL'
//     (spreadsheet), 'APP' (lot app), plus V5.0's 'csv_import'
//   - decode_source IS NOT NULL — every V5.0-native add (web manual entry,
//     VIN decoder, mobile app) sets it, whatever created_by carries
// Feed rows ('automatic…', 'CDK_BULK_UPDATE', 'CDK_IMPORT', null-created ETL
// rows without decode_source) are never touched.
//
// Soft-deactivate only (status='inactive') — the same way feed-removed
// vehicles fade out. Print history and options rows stay intact.

const MANUAL_CREATED_BY = ["VIN API", "EXCEL", "APP", "csv_import"];

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  // Destructive bulk action: admin-level roles only. dealer_user can print,
  // but mass-deactivating inventory is dealer_admin territory.
  if (claims.role === "dealer_user" || claims.role === "dealer_restricted") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const dealerId = params.id;
  if (!dealerId) return NextResponse.json({ error: "dealerId required" }, { status: 400 });

  // dealer_admin → own; group_admin → in-group; group_user → in-group+tag;
  // super_admin → any.
  const authz = await authorizeDealerAction(claims, dealerId);
  if (!authz.ok) return authz.response;

  const admin = createAdminSupabaseClient();

  // Two passes so the OR never needs PostgREST or-syntax quoting games
  // ('VIN API' contains a space): legacy markers first, then any remaining
  // V5.0-native adds (decode_source set). Counts can't overlap — pass 1
  // flips matching rows to inactive before pass 2 runs.
  const { count: byMarker, error: e1 } = await admin
    .from("dealer_vehicles")
    .update({ status: "inactive" }, { count: "exact" })
    .eq("dealer_id", dealerId)
    .eq("status", "active")
    .in("created_by", MANUAL_CREATED_BY);
  if (e1) return NextResponse.json({ error: e1.message || "Failed to clear manual vehicles" }, { status: 500 });

  const { count: byDecodeSource, error: e2 } = await admin
    .from("dealer_vehicles")
    .update({ status: "inactive" }, { count: "exact" })
    .eq("dealer_id", dealerId)
    .eq("status", "active")
    .not("decode_source", "is", null);
  if (e2) return NextResponse.json({ error: e2.message || "Failed to clear manual vehicles" }, { status: 500 });

  const cleared = (byMarker ?? 0) + (byDecodeSource ?? 0);

  fireWrite(admin.from("admin_audit").insert({
    admin_user_id: claims.sub,
    action: "manual_vehicles_cleared",
    target_dealer_id: dealerId,
    metadata: { cleared, by_marker: byMarker ?? 0, by_decode_source: byDecodeSource ?? 0, role: claims.role },
  }), "admin_audit");

  return NextResponse.json({ cleared });
}
