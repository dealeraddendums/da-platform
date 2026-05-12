// Mirrors the platform's current set of addendum line items for a vehicle
// into addendum_data — the single canonical table for all addendum line items
// going forward. Aurora-ETL rows carry legacy_id; platform-saved rows carry
// legacy_id = NULL. Print events insert their own rows (with printed_at +
// s3_key) directly from the pdf routes; this helper only manages the
// "current save-state" rows for a vehicle (printed_at IS NULL, s3_key IS NULL).
//
// Strategy: delete the prior save-state rows for this vehicle+dealer+
// document_type and re-insert the current set. Idempotent and safe to call
// on every save. No-ops if any required identifier is missing.

import type { SupabaseClient } from "@supabase/supabase-js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AddendumDocType = "addendum" | "infosheet" | "buyers_guide";

export interface SyncProduct {
  name: string;
  price?: string | null;
  required?: boolean | null;
  description?: string | null;
}

export interface SyncAddendumItemsArgs {
  vehicleId: string | null | undefined;
  dealerId: string | null | undefined;          // Supabase dealer UUID
  legacyDealerId: string | null | undefined;    // dealers.dealer_id (Aurora-style text)
  vin: string | null | undefined;
  documentType?: AddendumDocType;
  products: SyncProduct[];
}

/**
 * Sync the current save-state set of addendum line items for one vehicle
 * into addendum_data. No-ops if any of vehicleId / dealerId / vin are
 * missing or malformed. The DELETE is scoped to platform-save rows only
 * (legacy_id IS NULL AND s3_key IS NULL AND printed_at IS NULL), so Aurora
 * ETL rows and historical print-event snapshots are never touched.
 *
 * eslint-disable-next-line — using `any` for SupabaseClient generic so this
 * works with both the strongly-typed Database client and the looser admin
 * client without ceremony at every call site.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function syncAddendumItems(
  admin: SupabaseClient<any, "public", any>,
  args: SyncAddendumItemsArgs,
): Promise<void> {
  const vehicleId = args.vehicleId ?? "";
  const dealerId = args.dealerId ?? "";
  const legacyDealerId = (args.legacyDealerId ?? "").trim();
  const vin = (args.vin ?? "").trim();
  const documentType: AddendumDocType = args.documentType ?? "addendum";

  if (!UUID_RE.test(vehicleId)) return;   // legacy "0" sentinel and other non-UUIDs
  if (!UUID_RE.test(dealerId)) return;
  if (!vin) return;

  // Clear the prior save-state slice. Match the same predicate we'll use for
  // re-insert so Aurora-ETL rows (legacy_id NOT NULL) and print snapshots
  // (s3_key NOT NULL) are left intact.
  const { error: deleteErr } = await admin
    .from("addendum_data")
    .delete()
    .eq("vehicle_id", vehicleId)
    .eq("dealer_id", dealerId)
    .eq("document_type", documentType)
    .is("legacy_id", null)
    .is("s3_key", null)
    .is("printed_at", null);
  if (deleteErr) {
    console.error("[sync-addendum-items] delete error:", deleteErr.message);
    return;
  }

  if (args.products.length === 0) return;

  const nowIso = new Date().toISOString();
  const rows = args.products.map((p, i) => ({
    dealer_id: dealerId,
    legacy_dealer_id: legacyDealerId || null,
    vehicle_id: vehicleId,
    legacy_id: null as number | null,
    item_name: p.name,
    item_description: p.description ?? null,
    // Keep raw price string — modifier codes (FR, INC, NC, NP) must
    // round-trip exactly. addendum_data.item_price is varchar.
    item_price: p.price ?? null,
    vin_number: vin.toUpperCase(),
    document_type: documentType,
    required: p.required !== false,
    order_by: i,
    active: "1",
    or_or_ad: 1,
    created_at: nowIso,
    updated_at: nowIso,
  }));

  const { error: insertErr } = await admin
    .from("addendum_data")
    .insert(rows);
  if (insertErr) {
    console.error("[sync-addendum-items] insert error:", insertErr.message);
  }
}
