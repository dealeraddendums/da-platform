// Keep dealers.dealer_id in sync when inventory_dealer_id changes.
//
// dealer_id is the text key the whole platform uses (vehicles, ghost tokens,
// profiles, templates, dealer_settings, vehicle_options, print_history,
// addendum_library). It and inventory_dealer_id start equal at account creation
// but can drift. When staff change inventory_dealer_id to match the feed and the
// two were still in sync, dealer_id must follow — otherwise vehicle display and
// ghost mode break for that dealer.
//
// The actual rename is atomic and done in the DB by the cascade_dealer_id_change()
// function (migration 113): children follow via ON UPDATE CASCADE FKs, profiles
// (no FK) + inventory_dealer_id are updated in the same transaction. This helper
// decides whether to cascade (were in sync) or just set inventory_dealer_id
// (already drifted — leave dealer_id alone and warn).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

export class DealerIdSyncError extends Error {
  needsMigration: boolean;
  constructor(message: string, needsMigration = false) {
    super(message);
    this.name = "DealerIdSyncError";
    this.needsMigration = needsMigration;
  }
}

export type DealerInvRow = {
  id: string;
  dealer_id: string;
  inventory_dealer_id: string | null;
  name?: string | null;
};

export type InvSyncResult =
  | { changed: false }
  | { changed: true; cascaded: true; oldDealerId: string; newDealerId: string }
  | { changed: true; cascaded: false; outOfSync: boolean };

/**
 * Apply an inventory_dealer_id change to a dealer, keeping dealer_id in sync.
 *
 * - In sync (dealer_id === old inventory_dealer_id) and the id is actually
 *   changing → cascade the rename (dealer_id + inventory_dealer_id + all FK
 *   children + profiles) atomically via the cascade_dealer_id_change() RPC.
 * - Already out of sync (or inventory_dealer_id was null) → update
 *   inventory_dealer_id ONLY, leave dealer_id untouched, and log a warning.
 * - No actual change → no-op.
 *
 * Throws DealerIdSyncError on failure (needsMigration=true if the cascade
 * function isn't installed yet).
 */
export async function applyInventoryDealerIdChange(
  admin: Admin,
  dealer: DealerInvRow,
  newInventoryId: string,
): Promise<InvSyncResult> {
  const oldInv = dealer.inventory_dealer_id;
  if (newInventoryId === oldInv) return { changed: false };

  const inSync = oldInv != null && oldInv !== "" && dealer.dealer_id === oldInv;

  if (inSync) {
    // Atomic cascade: dealer_id + inventory_dealer_id → newInventoryId, and all
    // FK children + profiles follow, in one transaction.
    const { error } = await admin.rpc("cascade_dealer_id_change", {
      p_dealer_uuid: dealer.id,
      p_old: dealer.dealer_id,
      p_new: newInventoryId,
    });
    if (error) {
      const missing = /cascade_dealer_id_change|does not exist|schema cache|could not find/i.test(error.message ?? "");
      throw new DealerIdSyncError(
        missing
          ? "Cascade function missing — apply migration 113 (cascade_dealer_id_change) before changing a synced dealer's inventory ID."
          : error.message,
        missing,
      );
    }
    return { changed: true, cascaded: true, oldDealerId: dealer.dealer_id, newDealerId: newInventoryId };
  }

  // Already drifted (or inventory id was unset): only move inventory_dealer_id.
  const outOfSync = oldInv != null && oldInv !== "" && dealer.dealer_id !== oldInv;
  if (outOfSync) {
    console.warn(
      `[dealer-id-sync] dealer ${dealer.id}${dealer.name ? ` (${dealer.name})` : ""} already out of sync: ` +
      `dealer_id=${dealer.dealer_id} != inventory_dealer_id=${oldInv}. Setting inventory_dealer_id=${newInventoryId} ` +
      `only; leaving dealer_id unchanged.`,
    );
  }
  const { error } = await admin
    .from("dealers")
    .update({ inventory_dealer_id: newInventoryId })
    .eq("id", dealer.id);
  if (error) throw new DealerIdSyncError(error.message);
  return { changed: true, cascaded: false, outOfSync };
}
