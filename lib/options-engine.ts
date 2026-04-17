// Server-only: options matching engine — reads Aurora addendum_defaults.
// All writes go to Supabase vehicle_options. Never INSERT/UPDATE/DELETE Aurora.

import { getPool } from "@/lib/aurora";
import type { RowDataPacket } from "mysql2/promise";
import { vehicleCondition } from "@/lib/vehicles";
import type { VehicleRow } from "@/lib/vehicles";

// ── Aurora row types ──────────────────────────────────────────────────────────

type DefaultRow = RowDataPacket & {
  _ID: number;
  DEALER_ID: string;
  OPTION_NAME: string;
  ITEM_PRICE: string;
  AD_TYPE: string;
  MAKES: string;
  MAKES_NOT: number;
  MODELS: string;
  MODELS_NOT: number;
  TRIMS: string;
  TRIMS_NOT: number;
  BODY_STYLES: string;
  YEAR_CONDITION: number;
  YEAR: number | null;
  MILES_CONDITION: number;
  MILES: number | null;
  MSRP_CONDITION: number;
  MSRP1: number | null;
  MSRP2: number | null;
  RE_ORDER: number;
  ACTIVE: string;
};

type DataRow = RowDataPacket & {
  _ID: number;
  VEHICLE_ID: number;
  OPTION_NAME: string;
  ITEM_PRICE: string;
  ORDER_BY: number;
  ACTIVE: string;
};

export type MatchedOption = {
  default_id: number;
  option_name: string;
  option_price: string;
  sort_order: number;
  source: "default";
};

export type AppliedOption = {
  default_id: number;
  option_name: string;
  option_price: string;
  sort_order: number;
  source: "applied";
};

// ── Matching helpers ──────────────────────────────────────────────────────────

function listMatches(
  vehicleValue: string | null,
  listField: string,
  notFlag: number
): boolean {
  if (listField === "ALL" || !listField) return true;
  const val = (vehicleValue ?? "").toLowerCase().trim();
  const items = listField.split(",").map((s) => s.toLowerCase().trim()).filter(Boolean);
  const inList = items.some((item) => val === item || val.includes(item));
  return notFlag ? !inList : inList;
}

function matchesCondition(row: DefaultRow, vehicle: VehicleRow): boolean {
  const cond = vehicleCondition(vehicle);

  // AD_TYPE: New / Used / Both
  if (row.AD_TYPE === "New" && cond !== "New") return false;
  if (row.AD_TYPE === "Used" && cond === "New") return false;

  // Makes
  if (!listMatches(vehicle.MAKE, row.MAKES, row.MAKES_NOT)) return false;

  // Models
  if (!listMatches(vehicle.MODEL, row.MODELS, row.MODELS_NOT)) return false;

  // Trims
  if (!listMatches(vehicle.TRIM, row.TRIMS, row.TRIMS_NOT)) return false;

  // Body styles
  if (row.BODY_STYLES && row.BODY_STYLES !== "NONE") {
    if (!listMatches(vehicle.BODYSTYLE, row.BODY_STYLES, 0)) return false;
  }

  // Year condition
  const vehicleYear = vehicle.YEAR ? parseInt(vehicle.YEAR, 10) : null;
  if (row.YEAR_CONDITION !== 0 && row.YEAR != null && vehicleYear != null) {
    if (row.YEAR_CONDITION === 1 && vehicleYear !== row.YEAR) return false;
    if (row.YEAR_CONDITION === 2 && vehicleYear > row.YEAR) return false;
    if (row.YEAR_CONDITION === 3 && vehicleYear < row.YEAR) return false;
  }

  // Miles condition
  const vehicleMiles = vehicle.MILEAGE ? parseInt(vehicle.MILEAGE, 10) : null;
  if (row.MILES_CONDITION !== 0 && row.MILES != null && vehicleMiles != null) {
    if (row.MILES_CONDITION === 1 && vehicleMiles > row.MILES) return false;
    if (row.MILES_CONDITION === 2 && vehicleMiles < row.MILES) return false;
  }

  // MSRP condition
  const vehicleMsrp = vehicle.MSRP ? parseFloat(vehicle.MSRP) : null;
  if (row.MSRP_CONDITION !== 0 && vehicleMsrp != null) {
    if (row.MSRP_CONDITION === 1 && row.MSRP1 != null && vehicleMsrp > row.MSRP1) return false;
    if (row.MSRP_CONDITION === 2 && row.MSRP1 != null && vehicleMsrp < row.MSRP1) return false;
    if (row.MSRP_CONDITION === 3 && row.MSRP1 != null && row.MSRP2 != null) {
      if (vehicleMsrp < row.MSRP1 || vehicleMsrp > row.MSRP2) return false;
    }
  }

  return true;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the default options that match a vehicle's attributes.
 * These are suggestions — not yet saved. The caller decides whether to persist.
 */
export async function matchOptionsToVehicle(
  vehicle: VehicleRow,
  dealerId: string
): Promise<MatchedOption[]> {
  const pool = getPool();
  const [rows] = await pool.execute<DefaultRow[]>(
    `SELECT _ID, DEALER_ID, OPTION_NAME, ITEM_PRICE, AD_TYPE,
            MAKES, MAKES_NOT, MODELS, MODELS_NOT, TRIMS, TRIMS_NOT,
            BODY_STYLES, YEAR_CONDITION, YEAR, MILES_CONDITION, MILES,
            MSRP_CONDITION, MSRP1, MSRP2, RE_ORDER, ACTIVE
     FROM addendum_defaults
     WHERE DEALER_ID = ? AND ACTIVE = 'yes' -- TODO: verify this should use inventory_dealer_id
     ORDER BY RE_ORDER ASC`,
    [dealerId]
  );

  const matched: MatchedOption[] = [];
  for (const row of rows) {
    if (matchesCondition(row, vehicle)) {
      matched.push({
        default_id: row._ID,
        option_name: row.OPTION_NAME,
        option_price: row.ITEM_PRICE ?? "NC",
        sort_order: row.RE_ORDER,
        source: "default",
      });
    }
  }
  return matched;
}

/**
 * Returns vehicle-specific saved options from addendum_data (Aurora, read-only).
 * Used to pre-seed the Supabase vehicle_options table on first open.
 */
export async function getAuroraAppliedOptions(
  vehicleId: number,
  dealerId: string
): Promise<AppliedOption[]> {
  const pool = getPool();
  try {
    const [rows] = await pool.execute<DataRow[]>(
      `SELECT _ID, VEHICLE_ID, OPTION_NAME, ITEM_PRICE, ORDER_BY
       FROM addendum_data
       WHERE VEHICLE_ID = ? AND DEALER_ID = ? AND ACTIVE = 'yes' -- TODO: verify this should use inventory_dealer_id
       ORDER BY ORDER_BY ASC`,
      [vehicleId, dealerId]
    );
    return rows.map((r) => ({
      default_id: r._ID,
      option_name: r.OPTION_NAME,
      option_price: r.ITEM_PRICE ?? "NC",
      sort_order: r.ORDER_BY,
      source: "applied" as const,
    }));
  } catch {
    // addendum_data may not exist for all dealers — return empty
    return [];
  }
}

/**
 * Fetches all active default options for a dealer (the library / picker).
 */
export async function getDealerOptionLibrary(
  dealerId: string
): Promise<MatchedOption[]> {
  const pool = getPool();
  const [rows] = await pool.execute<DefaultRow[]>(
    `SELECT _ID, OPTION_NAME, ITEM_PRICE, RE_ORDER
     FROM addendum_defaults
     WHERE DEALER_ID = ? AND ACTIVE = 'yes' -- TODO: verify this should use inventory_dealer_id
     ORDER BY RE_ORDER ASC`,
    [dealerId]
  );
  return rows.map((r) => ({
    default_id: r._ID,
    option_name: r.OPTION_NAME,
    option_price: r.ITEM_PRICE ?? "NC",
    sort_order: r.RE_ORDER,
    source: "default" as const,
  }));
}

// Re-export client-safe price helpers
export { formatOptionPrice, parseOptionPriceValue } from "@/lib/option-price";
