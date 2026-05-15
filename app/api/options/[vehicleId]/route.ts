import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { getGroupOptionsForDealer, matchesRulesRow } from "@/lib/options-engine";
import { syncAddendumItems } from "@/lib/sync-addendum-items";
import type { VehicleOptionRow } from "@/lib/db";

type Params = { params: { vehicleId: string } };

function isUUID(v: string) { return v.includes("-"); }
function isManual(v: string) { return isUUID(v) || v === "0"; }

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
    .select("dealer_id, vin, stock_number, year, make, model, trim, body_style, exterior_color, mileage, msrp, condition")
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
    FUEL: null,
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
    HMPG: null,
    CMPG: null,
    MPG: null,
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

// Build a map of option_name → false for any addendum_library entries marked required=false.
// Used to override stale vehicle_options.required=true values when the library flag changed.
async function buildLibRequiredMap(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  dealerId: string,
  optionNames: string[]
): Promise<Record<string, boolean>> {
  if (optionNames.length === 0) return {};
  const { data } = await admin
    .from("addendum_library")
    .select("option_name, required")
    .eq("dealer_id", dealerId)
    .in("option_name", optionNames);
  const map: Record<string, boolean> = {};
  for (const r of data ?? []) {
    if (r.required === false) map[r.option_name as string] = false;
  }
  return map;
}

function applyLibRequired<T extends { option_name: string; required?: boolean | null }>(
  rows: T[],
  libMap: Record<string, boolean>
): T[] {
  return rows.map(r => {
    if (libMap[r.option_name] === false) return { ...r, required: false };
    return r;
  });
}

/**
 * Drop rows whose addendum_library entry exists but doesn't match the
 * current vehicle's rules. Rows with no library match are kept — they're
 * one-off custom additions the user explicitly attached to this vehicle.
 *
 * Library rules trump saved state by design: if a dealer narrows a
 * product to CHEVROLET/Silverado after it was already saved on a Nissan,
 * the Nissan's addendum should drop it. See bug report 2026-05-13.
 */
async function filterRowsByLibraryRules<T extends { option_name: string }>(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  dealerId: string,
  rows: T[],
  vehicle: import("@/lib/vehicles").VehicleRow | undefined,
): Promise<T[]> {
  if (!vehicle || rows.length === 0) return rows;
  const names = Array.from(new Set(rows.map(r => r.option_name)));
  const { data: lib } = await admin
    .from("addendum_library")
    .select("option_name, applies_to, ad_types, makes, makes_not, models, models_not, trims, trims_not, body_styles, year_condition, year_value, miles_condition, miles_value, msrp_condition, msrp1, msrp2")
    .eq("dealer_id", dealerId)
    .in("option_name", names);
  if (!lib || lib.length === 0) return rows;
  type LibRule = {
    option_name: string;
    applies_to: string | null;
    ad_types: string[] | null;
    makes: string | null;
    makes_not: boolean | null;
    models: string | null;
    models_not: boolean | null;
    trims: string | null;
    trims_not: boolean | null;
    body_styles: string | null;
    year_condition: number | null;
    year_value: number | null;
    miles_condition: number | null;
    miles_value: number | null;
    msrp_condition: number | null;
    msrp1: number | null;
    msrp2: number | null;
  };
  const ruleByName = new Map<string, LibRule>();
  for (const r of lib as unknown as LibRule[]) ruleByName.set(r.option_name, r);
  return rows.filter(r => {
    const rule = ruleByName.get(r.option_name);
    if (!rule) return true;        // no library row → custom add, keep
    return matchesRulesRow({
      applies_to: rule.applies_to,
      ad_types: rule.ad_types,
      makes: rule.makes,
      makes_not: rule.makes_not ?? false,
      models: rule.models,
      models_not: rule.models_not ?? false,
      trims: rule.trims,
      trims_not: rule.trims_not ?? false,
      body_styles: rule.body_styles,
      year_condition: rule.year_condition ?? 0,
      year_value: rule.year_value,
      miles_condition: rule.miles_condition ?? 0,
      miles_value: rule.miles_value,
      msrp_condition: rule.msrp_condition ?? 0,
      msrp1: rule.msrp1,
      msrp2: rule.msrp2,
    }, vehicle);
  });
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

    // ── Manual vehicle path (UUID or legacy '0') ─────────────────────────────
    if (isManual(vid)) {
      if (!effectiveDealerId) {
        return NextResponse.json({ data: [], groupOptions: [], source: "empty" });
      }

      const vehicleForRules = await loadVehicleForRules(admin, vid);
      const groupOptions = await getGroupOptionsForDealer(effectiveDealerId, vehicleForRules, isUUID(vid) ? vid : undefined);

      // Check for saved options keyed by this vehicleId
      const { data: saved } = await admin
        .from("vehicle_options")
        .select("*")
        .eq("vehicle_id", vid)
        .eq("dealer_id", effectiveDealerId)
        .order("sort_order", { ascending: true });

      if (saved && saved.length > 0) {
        const libMap = await buildLibRequiredMap(admin, effectiveDealerId, saved.map(r => r.option_name as string));
        const withRequired = applyLibRequired(saved, libMap);
        const filtered = await filterRowsByLibraryRules(admin, effectiveDealerId, withRequired, vehicleForRules);
        return NextResponse.json({ data: filtered, groupOptions, source: "saved" });
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
          const libMap = await buildLibRequiredMap(admin, effectiveDealerId, legacySaved.map(r => r.option_name as string));
          const withRequired = applyLibRequired(legacySaved, libMap);
          const filtered = await filterRowsByLibraryRules(admin, effectiveDealerId, withRequired, vehicleForRules);
          return NextResponse.json({ data: filtered, groupOptions, source: "saved" });
        }
      }

      // No saved options — seed from dealer's addendum_library, rules-filtered
      const { data: library } = await admin
        .from("addendum_library")
        .select("*")
        .eq("dealer_id", effectiveDealerId)
        .eq("active", true)
        .neq("applies_to", "none")
        .order("sort_order", { ascending: true });

      const libRows = library ?? [];
      const ruleFiltered = vehicleForRules
        ? libRows.filter(r => matchesRulesRow({
            applies_to: r.applies_to as string | null,
            ad_types: r.ad_types as string[] | null,
            makes: r.makes as string | null,
            makes_not: r.makes_not as boolean | undefined,
            models: r.models as string | null,
            models_not: r.models_not as boolean | undefined,
            trims: r.trims as string | null,
            trims_not: r.trims_not as boolean | undefined,
            body_styles: r.body_styles as string | null,
            year_condition: r.year_condition as number | undefined,
            year_value: r.year_value as number | null | undefined,
            miles_condition: r.miles_condition as number | undefined,
            miles_value: r.miles_value as number | null | undefined,
            msrp_condition: r.msrp_condition as number | undefined,
            msrp1: r.msrp1 as number | null | undefined,
            msrp2: r.msrp2 as number | null | undefined,
          }, vehicleForRules))
        : libRows;

      const matched = ruleFiltered.map((r, i) => ({
        default_id: r.id,
        option_name: r.option_name,
        option_price: r.item_price ?? "NC",
        description: r.description ?? null,
        sort_order: r.sort_order ?? i,
        source: "default" as const,
        required: (r.required ?? true) as boolean,
      }));

      return NextResponse.json({ data: matched, groupOptions, source: "matched", saved: false });
    }

    // ── Non-UUID, non-"0" vehicleId: not supported ──────────────────────────────
    // Fall back to dealer context from JWT — return empty options
    if (!effectiveDealerId) {
      return NextResponse.json({ data: [], groupOptions: [], source: "empty" });
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
      const libMap = await buildLibRequiredMap(admin, effectiveDealerId, saved.map(r => r.option_name as string));
      const withRequired = applyLibRequired(saved, libMap);
      const filtered = await filterRowsByLibraryRules(admin, effectiveDealerId, withRequired, vehicleForRulesFallback);
      return NextResponse.json({ data: filtered, groupOptions, source: "saved" });
    }

    // No saved options — seed from dealer's addendum_library
    const { data: library } = await admin
      .from("addendum_library")
      .select("*")
      .eq("dealer_id", effectiveDealerId)
      .eq("active", true)
      .neq("applies_to", "none")
      .order("sort_order", { ascending: true });

    const libRowsFallback = library ?? [];
    const ruleFilteredFallback = vehicleForRulesFallback
      ? libRowsFallback.filter(r => matchesRulesRow({
          applies_to: r.applies_to as string | null,
          ad_types: r.ad_types as string[] | null,
          makes: r.makes as string | null,
          makes_not: r.makes_not as boolean | undefined,
          models: r.models as string | null,
          models_not: r.models_not as boolean | undefined,
          trims: r.trims as string | null,
          trims_not: r.trims_not as boolean | undefined,
          body_styles: r.body_styles as string | null,
          year_condition: r.year_condition as number | undefined,
          year_value: r.year_value as number | null | undefined,
          miles_condition: r.miles_condition as number | undefined,
          miles_value: r.miles_value as number | null | undefined,
          msrp_condition: r.msrp_condition as number | undefined,
          msrp1: r.msrp1 as number | null | undefined,
          msrp2: r.msrp2 as number | null | undefined,
        }, vehicleForRulesFallback))
      : libRowsFallback;

    const matched = ruleFilteredFallback.map((r, i) => ({
      default_id: r.id,
      option_name: r.option_name,
      option_price: r.item_price ?? "NC",
      description: r.description ?? null,
      sort_order: r.sort_order ?? i,
      source: "default" as const,
      required: (r.required ?? true) as boolean,
    }));

    return NextResponse.json({ data: matched, groupOptions, source: "matched", saved: false });

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
