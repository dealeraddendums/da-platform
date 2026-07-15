import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient, fireWrite } from "@/lib/db";
import type { DealerRow } from "@/lib/db";
import { applyInventoryDealerIdChange, DealerIdSyncError } from "@/lib/dealer-id-sync";

type Params = { params: { id: string } };

/**
 * POST /api/dealers/[id]/inventory-dealer-id
 * super_admin only. Two-phase operation controlled by `confirm` flag.
 *
 * Phase 1 (confirm: false): validates and returns the vehicle count that will be deactivated.
 * Phase 2 (confirm: true): updates inventory_dealer_id, deactivates all dealer_vehicles,
 *   and logs to admin_audit.
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
    return NextResponse.json({ vehicle_count: vehicleCount });
  }

  const oldId = dealer.inventory_dealer_id;

  // Keep dealer_id in sync. If dealer_id == old inventory_dealer_id (they were
  // in sync), this cascades the rename across templates / dealer_settings /
  // vehicle_options / print_history / addendum_library / profiles AND sets both
  // text ids to newId — atomically, in one DB transaction. If already drifted,
  // it updates inventory_dealer_id only (and warns), leaving dealer_id alone.
  let syncResult;
  try {
    syncResult = await applyInventoryDealerIdChange(admin, dealer, newId);
  } catch (e) {
    if (e instanceof DealerIdSyncError) {
      return NextResponse.json({ error: e.message }, { status: e.needsMigration ? 409 : 500 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : "Update failed" }, { status: 500 });
  }

  // Re-read for the response — dealer_id may have changed too when cascaded.
  const { data: updatedDealer } = await admin
    .from("dealers")
    .select()
    .eq("id", params.id)
    .single();

  // Deactivate the OLD-id vehicles (dealer.dealer_id captured above). They get
  // re-ingested under the new feed id by DA Pulse. dealer_vehicles.dealer_id is
  // intentionally not cascaded — the feed change replaces the inventory.
  if (vehicleCount > 0) {
    await admin
      .from("dealer_vehicles")
      .update({ status: "inactive", updated_at: new Date().toISOString() })
      .eq("dealer_id", dealer.dealer_id)
      .eq("status", "active");
  }

  fireWrite(admin.from("admin_audit").insert({
    admin_user_id: claims.sub,
    action: "inventory_dealer_id_changed",
    target_dealer_id: dealer.dealer_id,
    metadata: {
      old_value: oldId ?? null,
      new_value: newId,
      vehicles_deactivated: vehicleCount,
      // Did dealer_id cascade with it? (true when they were in sync.)
      dealer_id_cascaded: syncResult.changed && syncResult.cascaded,
      dealer_id_old: dealer.dealer_id,
      dealer_id_new: (syncResult.changed && syncResult.cascaded) ? newId : dealer.dealer_id,
    },
  }), "admin_audit");

  return NextResponse.json({
    data: updatedDealer as DealerRow,
    vehicle_count: vehicleCount,
    dealer_id_cascaded: syncResult.changed && syncResult.cascaded,
  });
}
