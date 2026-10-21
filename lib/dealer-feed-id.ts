// Change a dealer's inventory_dealer_id (the Feed ID its inventory feed keys
// on) — the confirm phase of POST /api/dealers/[id]/inventory-dealer-id, moved
// here unchanged so DA-CRM's feed orders (Phase 2b, Confirm Feed ID) use the
// exact same code path: dealer_id cascade, FEED-AWARE handling of the old-id
// inventory (feed-owned rows deactivated only when a feed is live, everything
// else re-keyed and kept active), HubSpot sync and admin_audit.
// Callers check permissions first; `actorId` is recorded in admin_audit.
import { fireWrite } from "@/lib/db";
import { applyInventoryDealerIdChange, DealerIdSyncError } from "@/lib/dealer-id-sync";
import { fireDealerSync } from "@/lib/sync-hubspot";
import { getDealerFeedStatus, isFeedOwnedRow, type DealerFeedStatus } from "@/lib/dealer-feed-status";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Admin = any;

export class FeedIdChangeError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "FeedIdChangeError";
  }
}

export type FeedIdChangeResult = {
  updatedDealer: any;
  vehicleCount: number;
  vehiclesDeactivated: number;
  vehiclesRekeyed: number;
  feedStatus: DealerFeedStatus;
  cascaded: boolean;
};

export async function applyFeedIdChange(
  admin: Admin,
  dealer: { id: string; dealer_id: string; inventory_dealer_id: string | null; name: string },
  newId: string,
  vehicleCount: number,
  actorId: string,
): Promise<FeedIdChangeResult> {
  const oldId = dealer.inventory_dealer_id;

  // Keep dealer_id in sync. If dealer_id == old inventory_dealer_id (they were
  // in sync), this cascades the rename across templates / dealer_settings /
  // vehicle_options / print_history / addendum_library / profiles AND sets both
  // text ids to newId — atomically, in one DB transaction. If already drifted,
  // it updates inventory_dealer_id only (and warns), leaving dealer_id alone.
  // Feed status MUST be read before the cascade. cascade_dealer_id_change()
  // re-keys fortellis_dealers (migration 156), so a lookup by the old text id
  // afterwards finds no roster row and the config signal silently disappears.
  // It failed safe (toward keep-active) but reported the wrong reason; reading
  // it here describes the dealer as it actually was at rename time.
  const feedStatus = await getDealerFeedStatus(admin, dealer.dealer_id, dealer.inventory_dealer_id);

  let syncResult;
  try {
    syncResult = await applyInventoryDealerIdChange(admin, dealer, newId);
  } catch (e) {
    if (e instanceof DealerIdSyncError) throw new FeedIdChangeError(e.needsMigration ? 409 : 500, e.message);
    throw new FeedIdChangeError(500, e instanceof Error ? e.message : "Update failed");
  }

  // Re-read for the response — dealer_id may have changed too when cascaded.
  const { data: updatedDealer } = await admin
    .from("dealers")
    .select()
    .eq("id", dealer.id)
    .single();

  // ── Old-id inventory: FEED-AWARE, decided per row ────────────────────────
  // This used to deactivate every old-id vehicle unconditionally, on the
  // premise that "the feed re-ingests them under the new id". That premise
  // holds only for rows a feed actually owns. Riverside Ford Lincoln
  // (2026-09-03) had 49 csv_import vehicles and no feed at all, so the rename
  // emptied a live paying dealer's dashboard with nothing to refill it.
  //
  // dealer_vehicles is deliberately NOT part of cascade_dealer_id_change()
  // (migration 156 says so explicitly), so the re-key lives here — the cascade
  // itself is untouched and still does every other table.
  //
  // Per ROW, not per dealer, because mixed dealers are the real trap: Riverside
  // today carries automatic75 feed rows AND csv_import rows. Deactivating the
  // whole set would let the feed restore its own VINs while the manual ones
  // vanished for good.
  //
  //   feed-owned row + dealer has a live feed → deactivate (feed re-ingests it)
  //   anything else                           → re-key to the new id, keep ACTIVE
  //
  // Fail-safe direction throughout: keep it active. A feed dealer left with a
  // few stale-active rows self-corrects on its next sync; an emptied dashboard
  // does not.
  let vehiclesDeactivated = 0;
  let vehiclesRekeyed = 0;

  // Only touch inventory when the rename actually moved the key the vehicles
  // are filed under. On a drifted dealer (dealer_id != inventory_dealer_id) the
  // cascade changes inventory_dealer_id ONLY, so dealer_vehicles.dealer_id is
  // still correct — the old code deactivated them anyway, which was a second
  // way to empty a dashboard for no reason.
  const vehicleKeyMoved = syncResult.changed && syncResult.cascaded;

  if (vehicleKeyMoved && vehicleCount > 0) {
    const { data: oldRows } = await admin
      .from("dealer_vehicles")
      .select("id, created_by")
      .eq("dealer_id", dealer.dealer_id)
      .eq("status", "active") as { data: Array<{ id: string; created_by: string | null }> | null };

    const toDeactivate: string[] = [];
    const toRekey: string[] = [];
    for (const row of oldRows ?? []) {
      if (feedStatus.hasLiveFeed && isFeedOwnedRow(row.created_by)) toDeactivate.push(row.id);
      else toRekey.push(row.id);
    }

    const nowIso = new Date().toISOString();
    // Chunked: a busy dealer can exceed the URL length of a single .in() list.
    const CHUNK = 200;
    for (let i = 0; i < toRekey.length; i += CHUNK) {
      const ids = toRekey.slice(i, i + CHUNK);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: rekeyErr } = await (admin as any)
        .from("dealer_vehicles")
        .update({ dealer_id: newId, updated_at: nowIso })
        .in("id", ids);
      if (rekeyErr) {
        throw new FeedIdChangeError(500,
          `Dealer renamed, but re-keying its inventory failed: ${rekeyErr.message}. ${vehiclesRekeyed} of ${toRekey.length} vehicles moved — re-run or fix by hand before the dealer prints.`);
      }
      vehiclesRekeyed += ids.length;
    }
    for (let i = 0; i < toDeactivate.length; i += CHUNK) {
      const ids = toDeactivate.slice(i, i + CHUNK);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any)
        .from("dealer_vehicles")
        .update({ status: "inactive", updated_at: nowIso })
        .in("id", ids);
      vehiclesDeactivated += ids.length;
    }
  }

  // HubSpot: inventory_dealer_id maps to the Company `dealerid` property (sent
  // only once numeric). The general dealer PATCH fires this on every edit; this
  // dedicated route was the one write path that didn't — ss_→numeric assignments
  // made here never reached HubSpot (Buss Ford, 2026-07-25).
  fireDealerSync(dealer.id);

  fireWrite(admin.from("admin_audit").insert({
    admin_user_id: actorId,
    action: "inventory_dealer_id_changed",
    target_dealer_id: dealer.dealer_id,
    metadata: {
      old_value: oldId ?? null,
      new_value: newId,
      vehicles_deactivated: vehiclesDeactivated,
      vehicles_rekeyed_active: vehiclesRekeyed,
      dealer_has_live_feed: feedStatus.hasLiveFeed,
      feed_signals: feedStatus.signals,
      // Did dealer_id cascade with it? (true when they were in sync.)
      dealer_id_cascaded: syncResult.changed && syncResult.cascaded,
      dealer_id_old: dealer.dealer_id,
      dealer_id_new: (syncResult.changed && syncResult.cascaded) ? newId : dealer.dealer_id,
    },
  }), "admin_audit");


  return {
    updatedDealer,
    vehicleCount,
    vehiclesDeactivated,
    vehiclesRekeyed,
    feedStatus,
    cascaded: syncResult.changed && syncResult.cascaded,
  };
}

/** Active-vehicle count by the TEXT dealer_id (what dealer_vehicles keys on). */
export async function activeVehicleCount(admin: Admin, textDealerId: string): Promise<number> {
  const { count } = await admin.from("dealer_vehicles").select("id", { count: "exact", head: true })
    .eq("dealer_id", textDealerId).eq("status", "active");
  return count ?? 0;
}
