import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerRow } from "@/lib/db";
import { getDealerFeedStatus } from "@/lib/dealer-feed-status";
import { applyFeedIdChange, FeedIdChangeError } from "@/lib/dealer-feed-id";

type Params = { params: { id: string } };

/**
 * POST /api/dealers/[id]/inventory-dealer-id
 * super_admin only. Two-phase operation controlled by `confirm` flag.
 *
 * Phase 1 (confirm: false): validates and returns the dealer's active vehicle
 *   count plus whether it has a live feed (which decides what happens to them).
 * Phase 2 (confirm: true): updates inventory_dealer_id, cascades the text
 *   dealer_id, then handles the old-id inventory FEED-AWARELY — feed-owned rows
 *   are deactivated for the feed to re-ingest, everything else is re-keyed and
 *   stays ACTIVE — and logs to admin_audit.
 */
export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  let body: { new_id?: string; confirm?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const newId = body.new_id?.trim();
  if (!newId) {
    return NextResponse.json({ error: "new_id is required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  const { data: dealer } = await admin
    .from("dealers")
    .select("id, dealer_id, inventory_dealer_id, name")
    .eq("id", params.id)
    .single<{ id: string; dealer_id: string; inventory_dealer_id: string | null; name: string }>();

  if (!dealer) {
    return NextResponse.json({ error: "Dealer not found" }, { status: 404 });
  }

  // dealer_vehicles.dealer_id is the TEXT dealer_id (matches dealers.dealer_id),
  // NOT the dealers.id UUID — every ingestion path (CDK import, bulk update,
  // True ETL) keys by the text code. Counting/updating by params.id (which is
  // the UUID) silently matches zero rows, which is why the confirmation
  // dialog used to read "0 vehicles" for dealers with active inventory.
  const { count } = await admin
    .from("dealer_vehicles")
    .select("id", { count: "exact", head: true })
    .eq("dealer_id", dealer.dealer_id)
    .eq("status", "active");

  const vehicleCount = count ?? 0;

  if (!body.confirm) {
    // Additive preview fields so the confirm dialog can state what will actually
    // happen to the inventory instead of implying it all gets deactivated.
    const preview = await getDealerFeedStatus(admin, dealer.dealer_id, dealer.inventory_dealer_id);
    return NextResponse.json({
      vehicle_count: vehicleCount,
      dealer_has_live_feed: preview.hasLiveFeed,
      will_deactivate: preview.hasLiveFeed ? preview.signals.feedOwnedVehicles : 0,
      will_rekey_active: preview.hasLiveFeed ? preview.signals.nonFeedVehicles : vehicleCount,
      feed_signals: preview.signals,
    });
  }

  // The rename itself (cascade, feed-aware inventory handling, HubSpot,
  // admin_audit) lives in lib/dealer-feed-id.ts — shared with DA-CRM feed orders.
  let result;
  try {
    result = await applyFeedIdChange(admin, dealer, newId, vehicleCount, claims.sub);
  } catch (e) {
    if (e instanceof FeedIdChangeError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { updatedDealer, vehiclesDeactivated, vehiclesRekeyed, feedStatus } = result;

  return NextResponse.json({
    data: updatedDealer as DealerRow,
    vehicle_count: vehicleCount,
    vehicles_deactivated: vehiclesDeactivated,
    vehicles_rekeyed_active: vehiclesRekeyed,
    dealer_has_live_feed: feedStatus.hasLiveFeed,
    feed_signals: feedStatus.signals,
    dealer_id_cascaded: result.cascaded,
  });
}
