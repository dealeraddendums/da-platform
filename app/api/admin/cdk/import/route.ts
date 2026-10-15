import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { fetchCdkExtract, parseCdkVehicles, cdkCredsConfigured, formatCdkDeltaDate, type CdkVehicle } from "@/lib/cdk-api";
import { importCdkVehicles } from "@/lib/cdk-import";

/**
 * POST /api/admin/cdk/import
 * Body: { dealer_id, icompany, delta_date }
 *
 * Pulls vehicles from the CDK PIP extract endpoint, maps them to
 * dealer_vehicles columns, and inserts new rows. Existing rows are
 * skipped (ON CONFLICT DO NOTHING semantics via client-side dedup).
 * super_admin only.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  if (!cdkCredsConfigured()) {
    return NextResponse.json({ error: "CDK API credentials not configured" }, { status: 500 });
  }

  let body: { dealer_id?: string; icompany?: string; delta_date?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const dealerId = body.dealer_id?.trim();
  const iCompany = body.icompany?.trim();
  const deltaDate = body.delta_date?.trim();
  if (!dealerId || !iCompany || !deltaDate) {
    return NextResponse.json({ error: "dealer_id, icompany, delta_date are required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // ── Pull from CDK ─────────────────────────────────────────────────────────
  let vehicles: CdkVehicle[] = [];
  try {
    const { status, bodyText } = await fetchCdkExtract({ dealerId, iCompany, deltaDate });
    if (status < 200 || status >= 300) {
      return NextResponse.json({
        success: false,
        error: `CDK returned HTTP ${status}`,
        body_preview: bodyText.slice(0, 500),
      }, { status: 502 });
    }
    vehicles = parseCdkVehicles(bodyText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 502 });
  }

  if (vehicles.length === 0) {
    return NextResponse.json({
      success: true,
      vehicles_found: 0,
      vehicles_imported: 0,
      vehicles_skipped: 0,
    });
  }

  // Routing (incl. the shared Rick Case id), sold-skip and VIN dedup live in
  // lib/cdk-import.ts, shared with the bulk update.
  const result = await importCdkVehicles(admin, dealerId, vehicles);
  if (result.unrouted > 0 && result.imported + result.skipped === 0) {
    return NextResponse.json({
      success: false,
      error: `No Supabase dealer found for ${result.unroutedIds.join(", ")}`,
      vehicles_found: vehicles.length,
    }, { status: 404 });
  }

  // ── Mark the CDK row as imported: flip NEW → 'No' and stamp LAST_DELTA ──
  // Only happens on a successful CDK fetch + parse. If we reached here, the
  // CDK call returned 2xx and we parsed vehicles (or got an empty list,
  // which is still a valid response — the dealer just had no inventory
  // in that window). Failures earlier in the handler return before this.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // LAST_DELTA is the cutoff ETL2's hourly delta sends CDK next, so write it
    // in CDK's -0600 shape (an hour back, for overlap) — not a UTC "Z" string.
    // Match ICOMPANY too: 3PA0003717 is shared by two roster rows.
    await (admin as any).from("cdk_dealers")
      .update({ NEW: "No", LAST_DELTA: formatCdkDeltaDate(new Date(Date.now() - 3_600_000)) })
      .eq("DEALER_ID", dealerId)
      .eq("ICOMPANY", iCompany);
  } catch (err) {
    console.error("[cdk-import] CDK row update failed:", err instanceof Error ? err.message : err);
  }

  return NextResponse.json({
    success: true,
    vehicles_found: vehicles.length,
    vehicles_imported: result.imported,
    vehicles_skipped: result.skipped,
    vehicles_sold_skipped: result.sold,
    vehicles_unrouted: result.unrouted,
    unrouted_dealer_ids: result.unroutedIds,
  });
}
