import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { getGroupOptionsForDealer, savedRowSurvivesLibraryRules, normalizeOptionName, buildLiveRequiredByName, newlyAddedLibraryMatches, autoMatchedLibraryRows } from "@/lib/options-engine";
import { syncAddendumItems } from "@/lib/sync-addendum-items";
import type { VehicleOptionRow } from "@/lib/db";

type Params = { params: { vehicleId: string } };

function isUUID(v: string) { return v.includes("-"); }
function isManual(v: string) { return isUUID(v) || v === "0"; }

export type LegacyAddendumItem = { item_name: string; item_price: string; order_by: number };

/**
 * Legacy 4.0 addendum items for a vehicle — the rows the live widget/PDF and
 * feed export actually render for UNMIGRATED dealers (addendum_data, synced
 * from Aurora and reconciled nightly against 4.0 deletions/edits). Returned in
 * a SEPARATE `legacyAddendum` field so the AddendumEditor can display them
 * read-only: they must never enter the editable `data` list, or the
 * bulk-save-materializes-reads behavior (1fc67cd class) would silently persist
 * them into vehicle_options — and a later save could delete them. Empty for
 * migrated dealers and vehicles with no legacy rows.
 */
async function loadLegacyAddendum(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  dealerTextId: string,
  vin: string | null | undefined,
): Promise<LegacyAddendumItem[]> {
  if (!vin) return [];
  const { data: dealer } = await admin
    .from("dealers")
    .select("migration_status")
    .eq("dealer_id", dealerTextId)
    .maybeSingle<{ migration_status: string | null }>();
  if (!dealer || dealer.migration_status === "migrated") return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rows } = await (admin as any)
    .from("addendum_data")
    .select("item_name, item_price, order_by, created_at")
    .eq("legacy_dealer_id", dealerTextId)
    .eq("vin_number", vin.trim().toUpperCase())
    .in("active", ["1", "yes"]);
  // Dedupe by name keeping the newest row (defensive — reconcile keeps this
  // table current, but duplicates from the two historical ETL paths exist).
  const byName = new Map<string, { item_name: string; item_price: string; order_by: number; created_at: string | null }>();
  for (const r of (rows ?? []) as Array<{ item_name: string | null; item_price: string | null; order_by: number | null; created_at: string | null }>) {
    const name = String(r.item_name ?? "");
    if (!name) continue;
    const prev = byName.get(name);
    if (!prev || String(r.created_at ?? "") > String(prev.created_at ?? "")) {
      byName.set(name, { item_name: name, item_price: String(r.item_price ?? ""), order_by: Number(r.order_by) || 0, created_at: r.created_at });
    }
  }
  return Array.from(byName.values())
    .sort((a, b) => a.order_by - b.order_by)
    .map(({ item_name, item_price, order_by }) => ({ item_name, item_price, order_by }));
}

/**
 * Load the dealer_vehicle and shape it into the VehicleRow contract used by
 * the options-engine rules evaluator. Returns undefined for the legacy "0"
 * sentinel (manual / no vehicle) so the rules filter is skipped — the user
 * is editing the dealer's "no-vehicle" preset and we don't want to hide
 * rules-targeted corporate products in that surface.
 */
async function loadVehicleForRules(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  vehicleId: string,
): Promise<import("@/lib/vehicles").VehicleRow | undefined> {
  if (!isUUID(vehicleId)) return undefined;
  const { data: dv } = await admin
    .from("dealer_vehicles")
    .select("dealer_id, vin, stock_number, year, make, model, trim, body_style, exterior_color, mileage, msrp, condition, cmpg, hmpg, mpg, fuel")
    .eq("id", vehicleId)
    .maybeSingle();
  if (!dv) return undefined;
  type DV = {
    dealer_id: string;
    vin: string | null;
    stock_number: string | null;
    year: number | null;
    make: string | null;
    model: string | null;
    trim: string | null;
    body_style: string | null;
    exterior_color: string | null;
    mileage: number | null;
    msrp: number | null;
    condition: string | null;
    cmpg: string | null;
    hmpg: string | null;
    mpg: string | null;
    fuel: string | null;
  };
  const v = dv as unknown as DV;
  return {
    id: 0 as const,
    DEALER_ID: v.dealer_id,
    VIN_NUMBER: v.vin ?? "",
    STOCK_NUMBER: v.stock_number,
    YEAR: v.year != null ? String(v.year) : null,
    MAKE: v.make,
    MODEL: v.model,
    TRIM: v.trim,
    BODYSTYLE: v.body_style,
    EXT_COLOR: v.exterior_color,
    INT_COLOR: null,
    ENGINE: null,
    FUEL: v.fuel,
    DRIVETRAIN: null,
    TRANSMISSION: null,
    MILEAGE: v.mileage != null ? String(v.mileage) : null,
    DATE_IN_STOCK: null,
    STATUS: "1" as const,
    MSRP: v.msrp != null ? String(v.msrp) : null,
    NEW_USED: v.condition === "Used" ? "Used" : "New",
    CERTIFIED: v.condition === "CPO" ? "Yes" : "No",
    OPTIONS: null,
    PHOTOS: null,
    DESCRIPTION: null,
    PRINT_STATUS: "0" as const,
    HMPG: v.hmpg ?? null,
    CMPG: v.cmpg ?? null,
    MPG: v.mpg ?? null,
  };
}

/**
 * Mirror the current per-vehicle option set into addendum_data (save-state slice).
 * Resolves the dealer's UUID and the vehicle's vin from Supabase first
 * because the save path only has the text dealer_id and the vehicle UUID.
 * Fire-and-forget at the call site so a sync failure never blocks a save.
 */
async function mirrorToAddendumItems(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  vehicleId: string,
  dealerTextId: string,
  options: Array<{ option_name: string; option_price?: string; description?: string | null; required?: boolean }>,
): Promise<void> {
  try {
    if (!isUUID(vehicleId)) return; // legacy "0" sentinel — no real vehicle row
    const [dealerRes, vehicleRes] = await Promise.all([
      admin.from("dealers").select("id").eq("dealer_id", dealerTextId).maybeSingle<{ id: string }>(),
      admin.from("dealer_vehicles").select("vin").eq("id", vehicleId).maybeSingle<{ vin: string | null }>(),
    ]);
    await syncAddendumItems(admin, {
      vehicleId,
      dealerId: dealerRes.data?.id ?? null,
      legacyDealerId: dealerTextId,
      vin: vehicleRes.data?.vin ?? null,
      documentType: "addendum",
      products: options.map(o => ({
        name: o.option_name,
        price: o.option_price,
        description: o.description ?? null,
        required: o.required !== false,
      })),
    });
  } catch (err) {
    console.error("[options POST] addendum-items sync failed:", err instanceof Error ? err.message : err);
  }
}

// One full-library row shape shared by the type override, the rules gate,
// and the newly-added preview merge.
type DealerLibRow = {
  id: string;
  option_name: string;
  item_price: string | null;
  description: string | null;
  required: boolean | null;
  active: boolean | null;
  created_at: string | null;
  sort_order: number | null;
  applies_to: string | null;
  ad_types: string[] | null;
  makes: string | null;
  makes_not: boolean | null;
  models: string | null;
  models_not: boolean | null;
  trims: string | null;
  trims_not: boolean | null;
  body_styles: string | null;
  fuel: string | null;
  fuel_not: boolean | null;
  year_condition: number | null;
  year_value: number | null;
  miles_condition: number | null;
  miles_value: number | null;
  msrp_condition: number | null;
  msrp1: number | null;
  msrp2: number | null;
};

// Fetch the dealer's whole library once. Name-scoped queries
// (.in("option_name", savedNames)) silently missed library rows whose names
// differ from the saved rows by the legacy trailing-"^" marker, which broke
// the required-flag override and the rules gate for those products.
async function loadDealerLibrary(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  dealerId: string,
): Promise<DealerLibRow[]> {
  const { data } = await admin
    .from("addendum_library")
    .select("id, option_name, item_price, description, required, active, created_at, sort_order, applies_to, ad_types, makes, makes_not, models, models_not, trims, trims_not, body_styles, fuel, fuel_not, year_condition, year_value, miles_condition, miles_value, msrp_condition, msrp1, msrp2")
    .eq("dealer_id", dealerId)
    .order("sort_order", { ascending: true });
  return (data ?? []) as unknown as DealerLibRow[];
}

const libRowToRulesRow = (rule: DealerLibRow) => ({
  applies_to: rule.applies_to,
  ad_types: rule.ad_types,
  makes: rule.makes,
  makes_not: rule.makes_not ?? false,
  models: rule.models,
  models_not: rule.models_not ?? false,
  trims: rule.trims,
  trims_not: rule.trims_not ?? false,
  body_styles: rule.body_styles,
  fuel: rule.fuel,
  fuel_not: rule.fuel_not ?? false,
  year_condition: rule.year_condition ?? 0,
  year_value: rule.year_value,
  miles_condition: rule.miles_condition ?? 0,
  miles_value: rule.miles_value,
  msrp_condition: rule.msrp_condition ?? 0,
  msrp1: rule.msrp1,
  msrp2: rule.msrp2,
});

type SavedRow = {
  option_name: string;
  required?: boolean | null;
  sort_order?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
};

/**
 * Hydrate saved vehicle_options rows against the CURRENT library:
 *
 * 1. Live type — `required` (Required vs Suggested widget placement) always
 *    comes from the library when a same-name row exists; the value cached on
 *    vehicle_options at save time is only kept for custom one-offs with no
 *    library definition. Joined by normalizeOptionName (trailing-"^" safe).
 * 2. Rules gate — rows whose library rules no longer match the vehicle drop
 *    (library rules trump saved state, 2026-05-13); applies_to='none'
 *    manual-only products and "-NONE" sentinels never drop
 *    (savedRowSurvivesLibraryRules, shared with pdf/generate + pdf/bulk).
 * 3. New-product previews — library products created AFTER this vehicle's
 *    last save that rules-match the vehicle are appended as unpersisted
 *    source:"default" previews, so a product added to the library shows up
 *    on vehicles that already have saved options. Products the user removed
 *    from this vehicle predate the save and are NOT resurrected.
 */
function hydrateSavedAgainstLibrary<T extends SavedRow>(
  lib: DealerLibRow[],
  rows: T[],
  vehicle: import("@/lib/vehicles").VehicleRow | undefined,
) {
  const liveRequired = buildLiveRequiredByName(lib);
  const withLiveType = rows.map(r => {
    const live = liveRequired.get(normalizeOptionName(r.option_name));
    return live === undefined ? r : { ...r, required: live };
  });

  if (!vehicle) return withLiveType;

  // ALL same-name rows per name — a duplicate library entry must not collapse
  // the map and drop the real product (KARR-on-Maverick parity with pdf/generate).
  const rulesByName = new Map<string, ReturnType<typeof libRowToRulesRow>[]>();
  for (const r of lib) {
    const key = normalizeOptionName(r.option_name);
    const arr = rulesByName.get(key);
    if (arr) arr.push(libRowToRulesRow(r));
    else rulesByName.set(key, [libRowToRulesRow(r)]);
  }
  const filtered = withLiveType.filter(r =>
    savedRowSurvivesLibraryRules(rulesByName.get(normalizeOptionName(r.option_name)) ?? [], vehicle)
  );

  const fresh = newlyAddedLibraryMatches(lib, rows, vehicle);
  const maxSort = filtered.reduce((m, r) => Math.max(m, r.sort_order ?? 0), 0);
  const previews = fresh.map((r, i) => ({
    default_id: r.id,
    option_name: r.option_name,
    option_price: r.item_price ?? "NC",
    description: r.description ?? null,
    sort_order: maxSort + 1 + i,
    source: "default" as const,
    required: r.required !== false,
  }));

  return [...filtered, ...previews];
}

/**
 * GET /api/options/[vehicleId]
 * vehicleId can be:
 *   - UUID string: dealer_vehicle (dealer_vehicles.id)
 *   - "0":         legacy sentinel (backward compat, treated as manual)
 * Legacy integer vehicle IDs are not supported — use UUID from dealer_vehicles.
 */
export async function GET(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  try {
    const { claims, error } = await requireAuth();
    if (error) return error;

    const vid = params.vehicleId;
    const admin = createAdminSupabaseClient();
    const effectiveDealerId = claims.impersonating_dealer_id ?? claims.dealer_id;

    // Dealer price-display preference (migration 144) — piggybacked here so the
    // AddendumEditor preview can match print without needing /api/settings
    // (dealer_user is Forbidden there). Display-only.
    let alwaysShowCents = false;
    if (effectiveDealerId) {
      try {
        const { data: ds } = await admin
          .from("dealer_settings")
          .select("always_show_cents")
          .eq("dealer_id", effectiveDealerId)
          .maybeSingle<{ always_show_cents: boolean | null }>();
        alwaysShowCents = ds?.always_show_cents === true;
      } catch { /* column absent until migration 144 */ }
    }

    // ── Manual vehicle path (UUID or legacy '0') ─────────────────────────────
    if (isManual(vid)) {
      if (!effectiveDealerId) {
        return NextResponse.json({ data: [], groupOptions: [], source: "empty", alwaysShowCents });
      }

      const vehicleForRules = await loadVehicleForRules(admin, vid);
      const groupOptions = await getGroupOptionsForDealer(effectiveDealerId, vehicleForRules, isUUID(vid) ? vid : undefined);
      // Read-only legacy 4.0 items (unmigrated dealers) — displayed alongside
      // whatever the 5.0 pipeline yields so the operator sees what actually
      // exports/prints. Items whose name is already in the outgoing data are
      // filtered below to avoid double display.
      const legacyAll = await loadLegacyAddendum(admin, effectiveDealerId, vehicleForRules?.VIN_NUMBER);
      const legacyMinus = (names: Array<string | null | undefined>) => {
        if (!legacyAll.length) return [];
        const seen = new Set(names.map((n) => normalizeOptionName(String(n ?? ""))));
        return legacyAll.filter((l) => !seen.has(normalizeOptionName(l.item_name)));
      };

      // Check for saved options keyed by this vehicleId
      const { data: saved } = await admin
        .from("vehicle_options")
        .select("*")
        .eq("vehicle_id", vid)
        .eq("dealer_id", effectiveDealerId)
        .order("sort_order", { ascending: true });

      if (saved && saved.length > 0) {
        const lib = await loadDealerLibrary(admin, effectiveDealerId);
        const hydrated = hydrateSavedAgainstLibrary(lib, saved, vehicleForRules);
        return NextResponse.json({ data: hydrated, groupOptions, source: "saved", alwaysShowCents, legacyAddendum: legacyMinus(hydrated.map((h) => h.option_name)) });
      }

      // If UUID and nothing found, also check legacy '0' sentinel as fallback
      if (isUUID(vid)) {
        const { data: legacySaved } = await admin
          .from("vehicle_options")
          .select("*")
          .eq("vehicle_id", "0")
          .eq("dealer_id", effectiveDealerId)
          .order("sort_order", { ascending: true });

        if (legacySaved && legacySaved.length > 0) {
          const lib = await loadDealerLibrary(admin, effectiveDealerId);
          const hydrated = hydrateSavedAgainstLibrary(lib, legacySaved, vehicleForRules);
          return NextResponse.json({ data: hydrated, groupOptions, source: "saved", alwaysShowCents, legacyAddendum: legacyMinus(hydrated.map((h) => h.option_name)) });
        }
      }

      // No saved options — seed from the dealer's addendum_library, rules-
      // filtered. Shared with the feed export via autoMatchedLibraryRows so the
      // editor preview and the feed emit the identical matched set.
      const { data: library } = await admin
        .from("addendum_library")
        .select("*")
        .eq("dealer_id", effectiveDealerId)
        .eq("active", true)
        .neq("applies_to", "none")
        .order("sort_order", { ascending: true });

      const matched = autoMatchedLibraryRows(library ?? [], vehicleForRules);

      return NextResponse.json({ data: matched, groupOptions, source: "matched", saved: false, alwaysShowCents, legacyAddendum: legacyMinus(matched.map((m) => m.option_name)) });
    }

    // ── Non-UUID, non-"0" vehicleId: not supported ──────────────────────────────
    // Fall back to dealer context from JWT — return empty options
    if (!effectiveDealerId) {
      return NextResponse.json({ data: [], groupOptions: [], source: "empty", alwaysShowCents });
    }

    const vehicleForRulesFallback = await loadVehicleForRules(admin, vid);
    const groupOptions = await getGroupOptionsForDealer(effectiveDealerId, vehicleForRulesFallback, isUUID(vid) ? vid : undefined);

    // Check for saved options keyed by this vehicleId
    const { data: saved } = await admin
      .from("vehicle_options")
      .select("*")
      .eq("vehicle_id", vid)
      .eq("dealer_id", effectiveDealerId)
      .order("sort_order", { ascending: true });

    if (saved && saved.length > 0) {
      const lib = await loadDealerLibrary(admin, effectiveDealerId);
      const hydrated = hydrateSavedAgainstLibrary(lib, saved, vehicleForRulesFallback);
      return NextResponse.json({ data: hydrated, groupOptions, source: "saved", alwaysShowCents });
    }

    // No saved options — seed from the dealer's addendum_library (shared helper).
    const { data: library } = await admin
      .from("addendum_library")
      .select("*")
      .eq("dealer_id", effectiveDealerId)
      .eq("active", true)
      .neq("applies_to", "none")
      .order("sort_order", { ascending: true });

    const matched = autoMatchedLibraryRows(library ?? [], vehicleForRulesFallback);

    return NextResponse.json({ data: matched, groupOptions, source: "matched", saved: false, alwaysShowCents });

  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[options GET]", msg);
    return NextResponse.json({ error: msg, data: [], groupOptions: [] }, { status: 500 });
  }
}

/**
 * POST /api/options/[vehicleId]
 * Replaces all options for a vehicle (batch save).
 */
export async function POST(
  req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  try {
    const { claims, error } = await requireAuth();
    if (error) return error;

    const vid = params.vehicleId;
    type OptionInput = Pick<VehicleOptionRow, "option_name" | "option_price" | "sort_order" | "source"> & { description?: string | null; required?: boolean };
    const body = await req.json() as { options?: OptionInput[]; dealer_id?: string };
    if (!body.options || !Array.isArray(body.options)) {
      return NextResponse.json({ error: "options array required" }, { status: 400 });
    }

    const effectiveDealerId = claims.impersonating_dealer_id ?? claims.dealer_id;
    const admin = createAdminSupabaseClient();

    // Manual vehicle path (UUID or legacy '0')
    if (isManual(vid)) {
      if (!effectiveDealerId) {
        return NextResponse.json({ error: "No dealer context" }, { status: 403 });
      }
      await admin.from("vehicle_options").delete().eq("vehicle_id", vid).eq("dealer_id", effectiveDealerId);
      // Also clear legacy '0' sentinel if saving under UUID (migrate on write)
      if (isUUID(vid)) {
        await admin.from("vehicle_options").delete().eq("vehicle_id", "0").eq("dealer_id", effectiveDealerId);
      }
      const inserts = body.options.map((o, i) => ({
        vehicle_id: vid,
        dealer_id: effectiveDealerId,
        option_name: o.option_name,
        option_price: o.option_price ?? "NC",
        description: o.description ?? null,
        sort_order: o.sort_order ?? i,
        source: o.source ?? "manual",
        required: o.required !== false,
      }));
      const { data, error: insertErr } = await admin.from("vehicle_options").insert(inserts).select("*");
      if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });
      // Mirror to addendum_data (save-state slice). Fire-and-forget;
      // a failure here must not break the save.
      void mirrorToAddendumItems(admin, vid, effectiveDealerId, body.options);
      return NextResponse.json({ data });
    }

    // Non-UUID, non-"0" vehicleId: use dealer context from JWT
    if (!effectiveDealerId) {
      return NextResponse.json({ error: "No dealer context" }, { status: 403 });
    }

    await admin.from("vehicle_options").delete().eq("vehicle_id", vid).eq("dealer_id", effectiveDealerId);

    const inserts = body.options.map((o, i) => ({
      vehicle_id: vid,
      dealer_id: effectiveDealerId,
      option_name: o.option_name,
      option_price: o.option_price ?? "NC",
      description: o.description ?? null,
      sort_order: o.sort_order ?? i,
      source: o.source ?? "manual",
      required: o.required !== false,
    }));

    const { data, error: insertErr } = await admin
      .from("vehicle_options")
      .insert(inserts)
      .select("*");

    if (insertErr) {
      return NextResponse.json({ error: insertErr.message }, { status: 500 });
    }

    void mirrorToAddendumItems(admin, vid, effectiveDealerId, body.options);
    return NextResponse.json({ data });

  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[options POST]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
