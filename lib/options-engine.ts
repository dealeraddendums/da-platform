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
  fuel: string | null;
  fuel_not: boolean;
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
  /** Library def's name — used by savedRowSurvivesLibraryRules to narrow the
   *  same-name candidate set to exact-case matches (Serra APEX 2026-08-27). */
  option_name?: string | null;
  applies_to?: string | null;
  ad_types?: string[] | null;
  makes?: string | null;
  makes_not?: boolean;
  models?: string | null;
  models_not?: boolean;
  trims?: string | null;
  trims_not?: boolean;
  body_styles?: string | null;
  fuel?: string | null;
  fuel_not?: boolean;
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
  if (!listMatchesWithNot(vehicle.FUEL, row.fuel ?? null, !!row.fuel_not)) return false;

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

  // MSRP 0 / unparseable = UNPRICED, same as null (2026-08-12, null-MSRP
  // LYRIQ incident): a missing price must never gate a product in or out.
  // With vehicleMsrp null the msrp clause below is skipped entirely (treated
  // as passing) and the product's OTHER rules decide. Note the flip side:
  // complementary price-pair products ("under $50k" / "over $50k" variants)
  // BOTH match an unpriced vehicle by design.
  const msrpNum = vehicle.MSRP ? parseFloat(vehicle.MSRP) : NaN;
  const vehicleMsrp = Number.isFinite(msrpNum) && msrpNum > 0 ? msrpNum : null;
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

/**
 * "-NONE" / "NONE" / empty in the addendum_library list fields means "don't
 * auto-add to any vehicle" — an auto-add control, NOT a saved-option filter.
 * The rules matcher (listMatchesWithNot) would read "-NONE" as a literal value
 * matching no vehicle and wrongly drop an option already saved on the vehicle.
 * Collapse the sentinels to null (= no restriction); genuine list filters
 * (e.g. models="KARR") pass through untouched.
 */
export function normalizeSentinelList(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim().toUpperCase();
  if (t === "" || t === "-NONE" || t === "NONE") return null;
  if (v.split(",").map((s) => s.trim()).filter(Boolean).length === 0) return null;
  return v;
}

/**
 * Join key for matching vehicle_options rows to their addendum_library
 * definition by name. Legacy Aurora item names can carry a trailing "^"
 * marker that the old vehicle_options sync stripped ("AVC Appearance" saved
 * vs "AVC Appearance^" in the library), so exact-name joins silently miss —
 * which left stale required flags uncorrected (Napleton type-sync bug
 * 2026-07-13). Trim, drop trailing carets, and lowercase.
 */
export function normalizeOptionName(name: string | null | undefined): string {
  return (name ?? "").trim().replace(/\^+$/, "").trim().toLowerCase();
}

/** Case-PRESERVING analog of normalizeOptionName (trim + trailing carets
 *  only) — the identity key for exact-name matching between a saved row and
 *  its library definition. */
export function exactOptionName(name: string | null | undefined): string {
  return (name ?? "").trim().replace(/\^+$/, "").trim();
}

/**
 * Live Required/Suggested flag per library product, keyed by normalized
 * name. The library's CURRENT value always wins over the value cached on
 * vehicle_options at save time — `required` controls which widget (Required
 * vs Suggested) the product renders in, and that's a library-level setting,
 * not per-vehicle state. When a dealer has duplicate same-name rows, an
 * active row's flag beats an inactive one; ties keep the first seen
 * (sort_order query order).
 */
export function buildLiveRequiredByName(
  libRows: Array<{ option_name: string; required?: boolean | null; active?: boolean | null }>
): Map<string, boolean> {
  const picked = new Map<string, { required: boolean; active: boolean }>();
  for (const r of libRows) {
    const key = normalizeOptionName(r.option_name);
    if (!key) continue;
    const isActive = r.active !== false;
    const cur = picked.get(key);
    if (!cur || (isActive && !cur.active)) picked.set(key, { required: r.required !== false, active: isActive });
  }
  const map = new Map<string, boolean>();
  picked.forEach((v, k) => map.set(k, v.required));
  return map;
}

/**
 * Library products added AFTER a vehicle's options were last saved that
 * rules-match the vehicle. The saved set is a full-replace snapshot, so a
 * product added to the library later never appears on already-saved vehicles
 * (Napleton LuxCare bug 2026-07-13). Compare addendum_library.created_at
 * against the newest saved-row timestamp: newly created products merge in;
 * products the user deliberately REMOVED from this vehicle (which predate
 * the save) stay removed. Auto-add semantics match the no-saved-options seed
 * path: active rows only, applies_to='none' never auto-adds, raw rule values
 * (a "-NONE" sentinel means "don't auto-add" and is honored here).
 */
export function newlyAddedLibraryMatches<
  T extends { option_name: string; active?: boolean | null; created_at?: string | null; applies_to?: string | null }
>(
  libRows: T[],
  savedRows: Array<{ option_name: string; created_at?: string | null; updated_at?: string | null }>,
  vehicle: VehicleRow,
): T[] {
  if (savedRows.length === 0) return [];
  let lastSave = 0;
  for (const r of savedRows) {
    for (const t of [r.created_at, r.updated_at]) {
      const ms = t ? Date.parse(t) : NaN;
      if (!Number.isNaN(ms) && ms > lastSave) lastSave = ms;
    }
  }
  if (lastSave === 0) return []; // no usable save timestamp — can't tell new from removed
  const savedNames = new Set(savedRows.map(r => normalizeOptionName(r.option_name)));
  return libRows.filter(r => {
    if (r.active === false) return false;
    if (r.applies_to === "none") return false;
    if (savedNames.has(normalizeOptionName(r.option_name))) return false;
    const created = r.created_at ? Date.parse(r.created_at) : NaN;
    if (Number.isNaN(created) || created <= lastSave) return false;
    // Null-able rule columns are handled by matchesRulesRow at runtime
    // (`?? null` / `!!` coercion) — the cast bridges the row types coming
    // from the three call sites' differing selects.
    return matchesRulesRow(r as unknown as RulesRow, vehicle);
  });
}

export type AutoMatchedRow = {
  default_id: string;
  option_name: string;
  option_price: string;
  description: string | null;
  sort_order: number;
  source: "default";
  required: boolean;
};

/**
 * The dealer-library auto-match ("matched" preview) for a vehicle that has NO
 * saved vehicle_options — the unsaved set the addendum editor shows on a
 * never-touched vehicle. SINGLE SOURCE, shared by the options GET "matched"
 * branch and the feed export so the two can't drift (the feed used to lack a
 * seed and exported zeros for every never-saved vehicle at 5.0-native/synced
 * dealers).
 *
 * Semantics (identical to the options GET seed):
 *  - active rows only;
 *  - applies_to='none' never auto-adds;
 *  - rule-matched via matchesRulesRow, which honors a "-NONE"/"NONE" sentinel in
 *    a list field as "don't auto-add" (NOT normalized away — that normalization
 *    is only for the SAVED-row survival gate, savedRowSurvivesLibraryRules);
 *  - when `vehicle` is undefined (legacy "0"/manual, no dealer_vehicle) the rule
 *    filter is skipped, returning all active non-'none' rows (GET parity).
 *
 * Deliberately does NOT dedupe same-name library rows — it mirrors the editor
 * exactly, so a dealer with a duplicate library entry surfaces it in both the
 * editor and the feed (rather than the feed silently disagreeing with the
 * editor). Dedup, if ever wanted, belongs here so both call sites stay identical.
 */
export function autoMatchedLibraryRows(
  libRows: Array<Record<string, unknown> & { id: unknown; option_name: unknown }>,
  vehicle: VehicleRow | undefined,
): AutoMatchedRow[] {
  return libRows
    .filter((r) => (r.active as boolean | null | undefined) !== false && r.applies_to !== "none")
    .filter((r) => (vehicle ? matchesRulesRow(r as unknown as RulesRow, vehicle) : true))
    .map((r, i) => ({
      default_id: String(r.id),
      option_name: String(r.option_name),
      option_price: (r.item_price as string | null) ?? "NC",
      description: (r.description as string | null) ?? null,
      sort_order: (r.sort_order as number | null) ?? i,
      source: "default" as const,
      required: (r.required as boolean | null | undefined) !== false,
    }));
}

/**
 * Read/print-time gate for options ALREADY SAVED on a vehicle (vehicle_options)
 * against their current addendum_library definition(s). Shared by the options
 * GET, pdf/generate, and pdf/bulk so a saved option is displayed and printed by
 * the same rules everywhere. Differs from matchesRulesRow (the auto-add
 * matcher) in three ways:
 *
 * - applies_to='none' KEEPS the row. 'none' means "never auto-add — manual
 *   adds only", so a saved row for such a product can only exist because a
 *   user explicitly added it to this vehicle. matchesRulesRow rejects 'none'
 *   outright, which silently dropped manually-added products from reads and
 *   prints — and the next bulk save, built from the filtered read, deleted
 *   them from vehicle_options permanently (TestFlight bug 2026-07-08).
 * - The list-field sentinels are normalized via normalizeSentinelList
 *   (ABT print fix 2026-07-07, now applied at every read site).
 * - `rules` carries ALL same-name library rows for the dealer: any one match
 *   keeps the row, so a misconfigured duplicate can't drop the real product
 *   (KARR-on-Maverick fix).
 *
 * Rows with no library definition (rules = []) are custom one-offs — kept.
 * A genuine rule mismatch (applies_to='rules'/'all' that no longer matches
 * the vehicle) still drops: library rules trump saved state by design
 * (2026-05-13).
 */
export function savedRowSurvivesLibraryRules(rules: RulesRow[], vehicle: VehicleRow, savedName?: string | null): boolean {
  if (rules.length === 0) return true;
  // Identity narrowing (Serra APEX 2026-08-27): the same-name grouping is
  // case-INSENSITIVE, so "APEX PROTECT GPS" (New-only) and "APEX Protect GPS"
  // (Used-only, $595) shared one candidate set — and the New def matching a
  // New vehicle kept the USED $595 row alive on it (wrong product + price on
  // customer stickers). When the saved row's name matches one or more defs
  // EXACTLY (case preserved), the row belongs to those defs — judge survival
  // against them alone, so each twin is gated by ITS OWN condition/rules. The
  // case-insensitive any-match remains only as the fallback for saved rows
  // with case drift vs the library (the KARR class the any-match was built
  // for), where no exact-case def exists.
  let candidates = rules;
  if (savedName != null) {
    const key = exactOptionName(savedName);
    const exact = rules.filter(r => r.option_name != null && exactOptionName(r.option_name) === key);
    if (exact.length > 0) candidates = exact;
  }
  return candidates.some(rule =>
    rule.applies_to === "none" ||
    matchesRulesRow({
      ...rule,
      makes: normalizeSentinelList(rule.makes),
      models: normalizeSentinelList(rule.models),
      trims: normalizeSentinelList(rule.trims),
      body_styles: normalizeSentinelList(rule.body_styles),
      fuel: normalizeSentinelList(rule.fuel),
    }, vehicle)
  );
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
    .select("id, dealer_id, option_name, item_price, description, applies_to, makes, makes_not, models, models_not, trims, trims_not, body_styles, fuel, fuel_not, year_condition, year_value, miles_condition, miles_value, msrp_condition, msrp1, msrp2, sort_order, active, ad_types, required")
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
  /** Carried for back-compat; new callers should read `locked` instead. */
  is_locked: true;
  /** Per-product lock flag (migration 063). When false, the dealer may
   *  dismiss this product on a specific vehicle's addendum. Defaults to
   *  true so older rows stay locked. */
  locked: boolean;
  /** Layout hints from group_options (migration 053). Default false / 0. */
  separator_above?: boolean;
  separator_below?: boolean;
  spaces?: number;
  // ── Rule columns (migration 053), carried through for READ-ONLY display
  // (the Products-page rules tooltip / lib/rule-summary.ts). The rules were
  // already APPLIED above when vehicle context was passed; admin list views
  // get no vehicle, so they need the raw fields to describe each row.
  applies_to?: string | null;
  ad_types?: string[] | null;
  makes?: string | null;
  makes_not?: boolean | null;
  models?: string | null;
  models_not?: boolean | null;
  trims?: string | null;
  trims_not?: boolean | null;
  body_styles?: string | null;
  fuel?: string | null;
  fuel_not?: boolean | null;
  year_condition?: number | null;
  year_value?: number | null;
  miles_condition?: number | null;
  miles_value?: number | null;
  msrp_condition?: number | null;
  msrp1?: number | null;
  msrp2?: number | null;
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
  vehicleId?: string,
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

  // Per-vehicle dismissals (migration 063): when a product is unlocked
  // (locked=false), the dealer can hide it on one vehicle without removing
  // it from the group library. Skip the lookup when no vehicle id was
  // passed — admin list views don't need dismissals filtered out.
  let dismissedIds = new Set<string>();
  if (vehicleId) {
    // Cast through any — lib/db.ts Database type hasn't regenerated to
    // include the new dealer_dismissed_group_options table yet.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: dismissals } = await (admin as any)
      .from("dealer_dismissed_group_options")
      .select("group_option_id")
      .eq("vehicle_id", vehicleId);
    dismissedIds = new Set(((dismissals ?? []) as Array<{ group_option_id: string }>).map(d => d.group_option_id));
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
    .filter(r => {
      // Drop products the dealer has dismissed on this specific vehicle.
      // Only meaningful for locked=false products, but a row in
      // dealer_dismissed_group_options unconditionally wins — if a product
      // was unlocked, dismissed, then re-locked, the dismissal should still
      // hold for that vehicle. The toggle is an admin choice; the dismissal
      // is a dealer choice for one car.
      return !dismissedIds.has(r.id);
    })
    .map(r => {
      // Prefer the explicit `required` column added in migration 053; fall back
      // to the inverted is_suggested mapping for rows that pre-date the backfill.
      const required = typeof r.required === "boolean" ? r.required : !r.is_suggested;
      // locked column added in migration 063; pre-063 rows default to true
      // (the historical behavior) so existing corporate products stay locked.
      const locked = typeof r.locked === "boolean" ? r.locked : true;
      return {
        id: r.id,
        option_name: r.option_name,
        option_price: r.option_price,
        description: r.description ?? null,
        sort_order: r.sort_order,
        required,
        is_locked: true as const,
        locked,
        separator_above: r.separator_above === true,
        separator_below: r.separator_below === true,
        spaces: typeof r.spaces === "number" ? r.spaces : 0,
        // Rule columns for read-only display (rules tooltip). Additive —
        // print-merge consumers read specific fields and ignore these.
        applies_to: r.applies_to ?? null,
        ad_types: r.ad_types ?? null,
        makes: r.makes ?? null,
        makes_not: r.makes_not ?? null,
        models: r.models ?? null,
        models_not: r.models_not ?? null,
        trims: r.trims ?? null,
        trims_not: r.trims_not ?? null,
        body_styles: r.body_styles ?? null,
        fuel: r.fuel ?? null,
        fuel_not: r.fuel_not ?? null,
        year_condition: r.year_condition ?? null,
        year_value: r.year_value ?? null,
        miles_condition: r.miles_condition ?? null,
        miles_value: r.miles_value ?? null,
        msrp_condition: r.msrp_condition ?? null,
        msrp1: r.msrp1 ?? null,
        msrp2: r.msrp2 ?? null,
      };
    });
}

/**
 * Returns the list of group disclaimers applicable to a dealer, in render
 * order: locked (corporate-managed) first, then unlocked, alphabetical within
 * each group for stable ordering. Empty array when the dealer has no group,
 * no active disclaimers, or none match the dealer's state + document type.
 *
 * The Disclaimer widget in the Builder stacks these vertically. Auto-bottom
 * injection has been removed — disclaimers only print when a Disclaimer
 * widget is placed on the template (typically by a group admin).
 */
export async function getGroupDisclaimers(
  dealerTextId: string,
  dealerState: string | null,
  docType: string
): Promise<Array<{ text: string; locked: boolean }>> {
  const admin = createAdminSupabaseClient();

  const { data: dealer } = await admin
    .from("dealers")
    .select("group_id")
    .or(`dealer_id.eq.${dealerTextId},inventory_dealer_id.eq.${dealerTextId}`)
    .maybeSingle<{ group_id: string | null }>();

  if (!dealer?.group_id) return [];

  const { data: rows } = await admin
    .from("group_disclaimers")
    .select("*")
    .eq("group_id", dealer.group_id)
    .eq("active", true);

  if (!rows?.length) return [];

  const matched = (rows as GroupDisclaimerRow[]).filter((r) => {
    const stateOk = r.state_code === "ALL" || (dealerState && r.state_code.toUpperCase() === dealerState.toUpperCase());
    const typeOk = r.document_type === "all" || r.document_type === docType;
    return stateOk && typeOk;
  });

  return matched
    .map((r) => ({ text: r.disclaimer_text, locked: r.locked !== false }))
    .sort((a, b) => {
      if (a.locked !== b.locked) return a.locked ? -1 : 1;
      return a.text.localeCompare(b.text);
    });
}

/**
 * Back-compat shim — returns the joined disclaimer text the old auto-bottom
 * injection used to emit. Kept for any external caller that still wants a
 * single string; new code should use getGroupDisclaimers().
 */
export async function getGroupDisclaimer(
  dealerTextId: string,
  dealerState: string | null,
  docType: string
): Promise<string | null> {
  const rows = await getGroupDisclaimers(dealerTextId, dealerState, docType);
  if (!rows.length) return null;
  return rows.map((r) => r.text).join(" ");
}

// Re-export client-safe price helpers
export { formatOptionPrice, parseOptionPriceValue, isPipeExcludedPrice } from "@/lib/option-price";
