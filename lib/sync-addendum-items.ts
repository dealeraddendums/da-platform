// Mirrors the platform's current set of addendum line items for a vehicle
// into vehicle_addendum_items. That table is the reporting source DA-Pulse
// reads from — it carries both the one-time Aurora backfill (aurora_id IS
// NOT NULL) and live platform writes (aurora_id IS NULL). This helper only
// touches the platform side, so the backfill rows are always preserved.
//
// Strategy: for each save / print event, delete all platform-side rows for
// this vehicle and re-insert the current set. Cleaner than diffing per item
// because there's no DB unique constraint on (vehicle_id, item_name) — and
// we don't need history at line-item granularity on this table.

import type { SupabaseClient } from "@supabase/supabase-js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SyncProduct {
  name: string;
  price?: string | null;
}

/**
 * Parse a product price into a numeric (or null). Modifier codes (FR / INC /
 * NC / NP / similar all-caps tags) and percentage strings have no numeric
 * value — store null so reporting can distinguish "$X charge" from "free /
 * included / no-charge / percentage".
 */
function parsePrice(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^[A-Z]{2,4}$/i.test(s)) return null;
  if (s.includes("%")) return null;
  const cleaned = s.replace(/[$,\s]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Sync the current platform-side set of addendum line items for one vehicle.
 * Idempotent and safe to call on every save / print. No-ops if any of
 * vehicleId / dealerId / vin are missing or malformed.
 *
 * eslint-disable-next-line — using `any` for SupabaseClient generic so this
 * works with both the strongly-typed Database client and the looser admin
 * client without ceremony at every call site.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function syncAddendumItems(
  admin: SupabaseClient<any, "public", any>,
  args: {
    vehicleId: string | null | undefined;
    dealerId: string | null | undefined;
    vin: string | null | undefined;
    products: SyncProduct[];
  },
): Promise<void> {
  const vehicleId = args.vehicleId ?? "";
  const dealerId = args.dealerId ?? "";
  const vin = (args.vin ?? "").trim();
  if (!UUID_RE.test(vehicleId)) return;   // legacy "0" sentinel and other non-UUIDs
  if (!UUID_RE.test(dealerId)) return;
  if (!vin) return;

  const { error: deleteErr } = await admin
    .from("vehicle_addendum_items")
    .delete()
    .eq("vehicle_id", vehicleId)
    .is("aurora_id", null);
  if (deleteErr) {
    console.error("[sync-addendum-items] delete error:", deleteErr.message);
    return;
  }

  if (args.products.length === 0) return;

  const today = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();
  const rows = args.products.map(p => ({
    dealer_id: dealerId,
    vehicle_id: vehicleId,
    aurora_id: null,
    vin: vin.toUpperCase(),
    item_name: p.name,
    item_price: parsePrice(p.price ?? null),
    creation_date: today,
    synced_at: nowIso,
  }));

  const { error: insertErr } = await admin
    .from("vehicle_addendum_items")
    .insert(rows);
  if (insertErr) {
    console.error("[sync-addendum-items] insert error:", insertErr.message);
  }
}
