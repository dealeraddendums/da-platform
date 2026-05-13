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

/**
 * Generic rules-row shape: any row carrying the per-vehicle filter columns
 * shared between addendum_library and group_options.
 */
type RulesRow = {
  applies_to?: string | null;
  ad_types?: string[] | null;
  makes?: string | null;
  makes_not?: boolean;
  models?: string | null;
  models_not?: boolean;
  trims?: string | null;
  trims_not?: boolean;
  body_styles?: string | null;
  year_condition?: number;
  year_value?: number | null;
  miles_condition?: number;
  miles_value?: number | null;
  msrp_condition?: number;
  msrp1?: number | null;
  msrp2?: number | null;
};

/**
 * Per-vehicle rules evaluator shared by addendum_library and group_options.
 * Returns false if the row should be filtered out for this vehicle. Exported
 * so callers (pdf/generate, pdf/bulk, options route, etc.) can filter group
 * products against vehicle context without duplicating the logic.
 *
 * NOTE: matches when row.applies_to is 'all' OR 'rules' — both flow through
 * the same filter columns; 'all' rows simply tend to have empty filter lists.
 * applies_to='none' is rejected outright.
 */
export function matchesRulesRow(row: RulesRow, vehicle: VehicleRow): boolean {
  const cond = vehicleCondition(vehicle);

  if (row.applies_to === "none") return false;

  if (row.ad_types && row.ad_types.length > 0) {
    if (!row.ad_types.includes(cond)) return false;
  }

  if (!listMatchesWithNot(vehicle.MAKE, row.makes ?? null, !!row.makes_not)) return false;
  if (!listMatchesWithNot(vehicle.MODEL, row.models ?? null, !!row.models_not)) return false;
  if (!listMatchesWithNot(vehicle.TRIM, row.trims ?? null, !!row.trims_not)) return false;

  if (row.body_styles && row.body_styles !== "NONE" && row.body_styles !== "") {
    if (!listMatchesWithNot(vehicle.BODYSTYLE, row.body_styles, false)) return false;
  }

  const vehicleYear = vehicle.YEAR ? parseInt(vehicle.YEAR, 10) : null;
  if ((row.year_condition ?? 0) !== 0 && row.year_value != null && vehicleYear != null) {
    if (row.year_condition === 1 && vehicleYear !== row.year_value) return false;
    if (row.year_condition === 2 && vehicleYear > row.year_value) return false;
    if (row.year_condition === 3 && vehicleYear < row.year_value) return false;
  }

  const vehicleMiles = vehicle.MILEAGE ? parseInt(vehicle.MILEAGE, 10) : null;
  if ((row.miles_condition ?? 0) !== 0 && row.miles_value != null && vehicleMiles != null) {
    if (row.miles_condition === 1 && vehicleMiles > row.miles_value) return false;
    if (row.miles_condition === 2 && vehicleMiles < row.miles_value) return false;
  }

  const vehicleMsrp = vehicle.MSRP ? parseFloat(vehicle.MSRP) : null;
  if ((row.msrp_condition ?? 0) !== 0 && vehicleMsrp != null) {
    if (row.msrp_condition === 1 && row.msrp1 != null && vehicleMsrp > row.msrp1) return false;
    if (row.msrp_condition === 2 && row.msrp1 != null && vehicleMsrp < row.msrp1) return false;
    if (row.msrp_condition === 3 && row.msrp1 != null && row.msrp2 != null) {
      if (vehicleMsrp < row.msrp1 || vehicleMsrp > row.msrp2) return false;
    }
  }

  return true;
}

function matchesLibraryRow(row: LibraryRow, vehicle: VehicleRow): boolean {
  return matchesRulesRow(row, vehicle);
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
  /** Layout hints from group_options (migration 053). Default false / 0. */
  separator_above?: boolean;
  separator_below?: boolean;
  spaces?: number;
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
  dealerTextId: string,
  vehicle?: VehicleRow,
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

  // Resolve which specific-scope products are explicitly assigned to this
  // dealer. assign_all_dealers=true products skip the assignment check.
  const selectScopeIds = (rows as GroupOptionRow[])
    .filter(r => r.assign_all_dealers === false)
    .map(r => r.id);

  let assignedIds = new Set<string>();
  if (selectScopeIds.length > 0) {
    const { data: assigns } = await admin
      .from("dealer_option_assignments")
      .select("option_id")
      .eq("dealer_id", dealer.id)
      .eq("group_id", dealer.group_id)
      .eq("dealer_editable", false)
      .in("option_id", selectScopeIds);
    assignedIds = new Set((assigns ?? []).map(a => a.option_id as string));
  }

  return (rows as GroupOptionRow[])
    .filter(r => {
      // assign_all_dealers=true → product applies to every current and future
      // dealer in the group. assign_all_dealers=false → only dealers explicitly
      // listed in dealer_option_assignments (with dealer_editable=false; the
      // editable flow already copies into addendum_library and is its own
      // surface).
      if (r.assign_all_dealers !== false) return true;
      return assignedIds.has(r.id);
    })
    .filter(r => {
      // Per-vehicle rules filter (Make/Model/Year/Mileage/MSRP/Trim/Bodystyle).
      // When no vehicle context is passed (e.g. corporate-products admin list),
      // skip the filter — the caller is looking at the product set, not a
      // specific vehicle's effective set.
      if (!vehicle) return true;
      // group_options carries the same rules columns as addendum_library
      // (migration 053). Cast through unknown so the type signature matches.
      return matchesRulesRow(r as unknown as RulesRow, vehicle);
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
        separator_above: r.separator_above === true,
        separator_below: r.separator_below === true,
        spaces: typeof r.spaces === "number" ? r.spaces : 0,
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
