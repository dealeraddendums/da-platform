// Server-only: options matching engine — reads Supabase addendum_library.

import { vehicleCondition } from "@/lib/vehicles";
import type { VehicleRow } from "@/lib/vehicles";
import { createAdminSupabaseClient } from "@/lib/db";
import type { GroupOptionRow, GroupDisclaimerRow } from "@/lib/db";

// ── Supabase addendum_library row type ────────────────────────────────────────

type LibraryRow = {
  id: string;
  dealer_id: string;
  option_name: string;
  item_price: string | null;
  description: string | null;
  applies_to: string | null; // 'all' | 'rules' | 'none'
  makes: string | null;
  makes_not: boolean;
  models: string | null;
  models_not: boolean;
  trims: string | null;
  trims_not: boolean;
  body_styles: string | null;
  year_condition: number;
  year_value: number | null;
  miles_condition: number;
  miles_value: number | null;
  msrp_condition: number;
  msrp1: number | null;
  msrp2: number | null;
  sort_order: number;
  active: boolean;
  ad_types: string[] | null;
  required: boolean;
};

export type MatchedOption = {
  default_id: string;
  option_name: string;
  option_price: string;
  sort_order: number;
  source: "default";
  required: boolean;
};


// ── Matching helpers ──────────────────────────────────────────────────────────

function listMatchesWithNot(
  vehicleValue: string | null,
  listField: string | null,
  notFlag: boolean
): boolean {
  if (!listField || listField === "ALL" || listField === "") return true;
  const val = (vehicleValue ?? "").toLowerCase().trim();
  if (!val) return !notFlag; // empty vehicle value: matches "ALL" lists but not specific ones
  const items = listField.split(",").map((s) => s.toLowerCase().trim()).filter(Boolean);
  if (items.length === 0) return true;
  const inList = items.some((item) => val === item || val.includes(item));
  return notFlag ? !inList : inList;
}

/** Check if a vehicle condition matches a Supabase library row's applies_to field. */
export function matchesAdTypes(
  adTypes: string[] | null | undefined,
  vehicleCond: "New" | "Used" | "CPO"
): boolean {
  if (!adTypes || adTypes.length === 0) return true;
  return adTypes.includes(vehicleCond);
}

function matchesLibraryRow(row: LibraryRow, vehicle: VehicleRow): boolean {
  const cond = vehicleCondition(vehicle);

  // applies_to: 'none' never matches; 'rules' defers to ad_types; 'all' always continues
  if (row.applies_to === "none") return false;

  // ad_types array (newer schema — 'New', 'Used', 'CPO')
  if (row.ad_types && row.ad_types.length > 0) {
    if (!row.ad_types.includes(cond)) return false;
  }

  // Makes
  if (!listMatchesWithNot(vehicle.MAKE, row.makes, row.makes_not)) return false;

  // Models
  if (!listMatchesWithNot(vehicle.MODEL, row.models, row.models_not)) return false;

  // Trims
  if (!listMatchesWithNot(vehicle.TRIM, row.trims, row.trims_not)) return false;

  // Body styles (no NOT flag in library schema)
  if (row.body_styles && row.body_styles !== "NONE" && row.body_styles !== "") {
    if (!listMatchesWithNot(vehicle.BODYSTYLE, row.body_styles, false)) return false;
  }

  // Year condition
  const vehicleYear = vehicle.YEAR ? parseInt(vehicle.YEAR, 10) : null;
  if (row.year_condition !== 0 && row.year_value != null && vehicleYear != null) {
    if (row.year_condition === 1 && vehicleYear !== row.year_value) return false;
    if (row.year_condition === 2 && vehicleYear > row.year_value) return false;
    if (row.year_condition === 3 && vehicleYear < row.year_value) return false;
  }

  // Miles condition
  const vehicleMiles = vehicle.MILEAGE ? parseInt(vehicle.MILEAGE, 10) : null;
  if (row.miles_condition !== 0 && row.miles_value != null && vehicleMiles != null) {
    if (row.miles_condition === 1 && vehicleMiles > row.miles_value) return false;
    if (row.miles_condition === 2 && vehicleMiles < row.miles_value) return false;
  }

  // MSRP condition
  const vehicleMsrp = vehicle.MSRP ? parseFloat(vehicle.MSRP) : null;
  if (row.msrp_condition !== 0 && vehicleMsrp != null) {
    if (row.msrp_condition === 1 && row.msrp1 != null && vehicleMsrp > row.msrp1) return false;
    if (row.msrp_condition === 2 && row.msrp1 != null && vehicleMsrp < row.msrp1) return false;
    if (row.msrp_condition === 3 && row.msrp1 != null && row.msrp2 != null) {
      if (vehicleMsrp < row.msrp1 || vehicleMsrp > row.msrp2) return false;
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
  const admin = createAdminSupabaseClient();
  const { data: rows } = await admin
    .from("addendum_library")
    .select("id, dealer_id, option_name, item_price, description, applies_to, makes, makes_not, models, models_not, trims, trims_not, body_styles, year_condition, year_value, miles_condition, miles_value, msrp_condition, msrp1, msrp2, sort_order, active, ad_types, required")
    .eq("dealer_id", dealerId)
    .eq("active", true)
    .neq("applies_to", "none")
    .order("sort_order", { ascending: true });

  const matched: MatchedOption[] = [];
  for (const row of (rows ?? []) as LibraryRow[]) {
    if (matchesLibraryRow(row, vehicle)) {
      matched.push({
        default_id: row.id,
        option_name: row.option_name,
        option_price: row.item_price ?? "NC",
        sort_order: row.sort_order,
        source: "default",
        required: row.required ?? true,
      });
    }
  }
  return matched;
}


/**
 * Fetches all active default options for a dealer (the library / picker).
 * Reads from Supabase addendum_library.
 */
export async function getDealerOptionLibrary(
  dealerId: string
): Promise<MatchedOption[]> {
  const admin = createAdminSupabaseClient();
  const { data: rows } = await admin
    .from("addendum_library")
    .select("id, option_name, item_price, sort_order, required")
    .eq("dealer_id", dealerId)
    .eq("active", true)
    .order("sort_order", { ascending: true });

  return (rows ?? []).map((r) => ({
    default_id: r.id as string,
    option_name: r.option_name as string,
    option_price: (r.item_price ?? "NC") as string,
    sort_order: r.sort_order as number,
    source: "default" as const,
    required: (r.required ?? true) as boolean,
  }));
}

// ── Group-level options + disclaimers ─────────────────────────────────────────

export type LockedOption = {
  id: string;
  option_name: string;
  option_price: string;
  description: string | null;
  sort_order: number;
  required: boolean;
  is_locked: true;
};

/**
 * Returns active group options for the dealer identified by their dealer_id,
 * scoped to what should appear on this specific dealer's addendum:
 *   - Required (Corporate) products: always returned for any dealer in the group.
 *   - Suggested products: only returned when an explicit assignment exists in
 *     dealer_option_assignments with dealer_editable=false (locked). Editable
 *     assignments are already copied to the dealer's own addendum_library by
 *     the assignments endpoint, so they appear via the dealer's product flow,
 *     not via this locked-group-option flow.
 *
 * Looks up the Supabase group_id and dealer UUID via dealers.dealer_id or
 * inventory_dealer_id.
 */
export async function getGroupOptionsForDealer(
  dealerTextId: string
): Promise<LockedOption[]> {
  const admin = createAdminSupabaseClient();

  const { data: dealer } = await admin
    .from("dealers")
    .select("id, group_id")
    .or(`dealer_id.eq.${dealerTextId},inventory_dealer_id.eq.${dealerTextId}`)
    .maybeSingle<{ id: string; group_id: string | null }>();

  if (!dealer?.group_id) return [];

  const { data: rows } = await admin
    .from("group_options")
    .select("*")
    .eq("group_id", dealer.group_id)
    .eq("active", true)
    .order("sort_order");

  if (!rows || rows.length === 0) return [];

  // Resolve which suggested options are locked-assigned to this dealer.
  const suggestedIds = (rows as GroupOptionRow[])
    .filter(r => r.is_suggested === true)
    .map(r => r.id);

  let lockedSuggestedIds = new Set<string>();
  if (suggestedIds.length > 0) {
    const { data: assigns } = await admin
      .from("dealer_option_assignments")
      .select("option_id")
      .eq("dealer_id", dealer.id)
      .eq("group_id", dealer.group_id)
      .eq("dealer_editable", false)
      .in("option_id", suggestedIds);
    lockedSuggestedIds = new Set((assigns ?? []).map(a => a.option_id as string));
  }

  return (rows as GroupOptionRow[])
    .filter(r => {
      // Required corporate product → always show on every dealer in the group.
      // Suggested → only show when locked-assigned to this dealer.
      if (r.is_suggested !== true) return true;
      return lockedSuggestedIds.has(r.id);
    })
    .map(r => {
      // Prefer the explicit `required` column added in migration 053; fall back
      // to the inverted is_suggested mapping for rows that pre-date the backfill.
      const required = typeof r.required === "boolean" ? r.required : !r.is_suggested;
      return {
        id: r.id,
        option_name: r.option_name,
        option_price: r.option_price,
        description: r.description ?? null,
        sort_order: r.sort_order,
        required,
        is_locked: true as const,
      };
    });
}

/**
 * Returns combined disclaimer text for a dealer's applicable group disclaimers.
 * Matches by state_code ('ALL' or exact match) and document_type ('all' or exact).
 */
export async function getGroupDisclaimer(
  dealerTextId: string,
  dealerState: string | null,
  docType: string
): Promise<string | null> {
  const admin = createAdminSupabaseClient();

  const { data: dealer } = await admin
    .from("dealers")
    .select("group_id")
    .or(`dealer_id.eq.${dealerTextId},inventory_dealer_id.eq.${dealerTextId}`)
    .maybeSingle<{ group_id: string | null }>();

  if (!dealer?.group_id) return null;

  const { data: rows } = await admin
    .from("group_disclaimers")
    .select("*")
    .eq("group_id", dealer.group_id)
    .eq("active", true);

  if (!rows?.length) return null;

  const matched = (rows as GroupDisclaimerRow[]).filter((r) => {
    const stateOk = r.state_code === "ALL" || (dealerState && r.state_code.toUpperCase() === dealerState.toUpperCase());
    const typeOk = r.document_type === "all" || r.document_type === docType;
    return stateOk && typeOk;
  });

  if (!matched.length) return null;
  return matched.map((r) => r.disclaimer_text).join(" ");
}

// Re-export client-safe price helpers
export { formatOptionPrice, parseOptionPriceValue } from "@/lib/option-price";
