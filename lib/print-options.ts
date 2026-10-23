// The products a vehicle prints, resolved exactly as POST /api/pdf/generate prints them — extracted
// verbatim from that route (2026-10-23) so the Template Builder's "As vehicle" preview renders the
// identical set and prices. The print route calls this; never re-implement it.
//
// In: the dealer_vehicles row (dv), its id, and the dealer's TEXT id. Out: the vehicle shaped for the
// renderer, the merged options (corporate first, then saved / newly-added / seeded dealer rows) and the
// save-on-print set.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { getGroupOptionsForDealer, matchesRulesRow, savedRowSurvivesLibraryRules, normalizeOptionName, buildLiveRequiredByName, newlyAddedLibraryMatches, autoMatchedLibraryRows, libraryNameSet, libraryIdSet, libraryNameById, liveOptionName, pruneOrphanedDefaultRows } from "@/lib/options-engine";
import { hasLegacyAddendumData, type SaveOption } from "@/lib/vehicle-options-save";
import { vehicleConditionFields } from "@/lib/vehicles";

export async function resolveVehiclePrintOptions(admin: any, dv: any, dealerVehicleId: string, textDealerId: string) {
  // Options are fetched AFTER the library load below — the orphan prune
  // (pruneOrphanedDefaultRows) needs the library's name set before the
  // uuid → sentinel → seed cascade can be decided.
  const optionsExplicitlySaved = Boolean((dv as Record<string, unknown>).options_saved_at);

  // For options missing a description, fall back to addendum_library by name.
  // Also load required + layout (separator_above/below, spaces) so the
  // renderer can honor the dealer's library-side formatting on every print.
  // The library rules (Make/Model/Year/...) also gate the saved options at
  // print time — if a saved option's library row exists but doesn't match
  // the vehicle, it's dropped here. Library rules trump saved state by design.
  //
  // The library is fetched WHOLE (not name-scoped) and joined by
  // normalizeOptionName: saved names can differ from library names by the
  // legacy trailing-"^" marker, and the newly-added-product merge below
  // needs rows whose names aren't saved yet.
  type GenLibRow = {
    id: string;
    option_name: string;
    item_price: string | null;
    description: string | null;
    required: boolean | null;
    active: boolean | null;
    created_at: string | null;
    separator_above: boolean | null;
    separator_below: boolean | null;
    spaces: number | null;
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
    apply_when_no_msrp?: boolean | null;
  };
  let dealerLib: GenLibRow[] = [];
  const libDescMap: Record<string, string | null> = {};
  const libLayoutMap: Record<string, { separator_above: boolean; separator_below: boolean; spaces: number }> = {};
  // Keyed by normalized option_name → ARRAY of rules: a dealer can have
  // multiple library rows with the same name (e.g. an accidental duplicate).
  // Collapsing them to one (Map<name, rule>) let a misconfigured "applies to
  // none" duplicate win the slot and drop the real product at print time
  // (KARR-on-Maverick bug).
  const libRulesByName = new Map<string, Parameters<typeof matchesRulesRow>[0][]>();
  // Load the library unconditionally (was gated on optionRows>0): the
  // never-saved SEED below needs it so single-generate renders matched
  // products just like the editor + pdf/bulk (save-on-print, 2026-08-01).
  {
    const { data: libRows } = await admin
      .from("addendum_library")
      .select("id, option_name, item_price, description, required, active, created_at, separator_above, separator_below, spaces, applies_to, ad_types, makes, makes_not, models, models_not, trims, trims_not, body_styles, fuel, fuel_not, year_condition, year_value, miles_condition, miles_value, msrp_condition, msrp1, msrp2, apply_when_no_msrp")
      .eq("dealer_id", dv.dealer_id)
      .order("sort_order", { ascending: true });
    dealerLib = (libRows ?? []) as unknown as GenLibRow[];
    for (const lr of dealerLib) {
      const name = normalizeOptionName(lr.option_name);
      if (lr.description && libDescMap[name] === undefined) libDescMap[name] = lr.description;
      if (libLayoutMap[name] === undefined) {
        libLayoutMap[name] = {
          separator_above: lr.separator_above === true,
          separator_below: lr.separator_below === true,
          spaces: typeof lr.spaces === "number" ? lr.spaces : 0,
        };
      }
      // Raw rule rows — savedRowSurvivesLibraryRules normalizes the
      // "-NONE"/"NONE"/empty auto-add sentinels and keeps applies_to='none'
      // manual-only products at compare time. libRulesByName is used only
      // for the savedFiltered gate below, so auto-add (which reads the raw
      // addendum_library value elsewhere) is unaffected.
      const ruleRow = {
        id: lr.id as string | null,
        option_name: lr.option_name as string | null,
        item_price: (lr.item_price as string | null) ?? null,
        applies_to: lr.applies_to,
        ad_types: lr.ad_types,
        makes: lr.makes,
        makes_not: lr.makes_not ?? false,
        models: lr.models,
        models_not: lr.models_not ?? false,
        trims: lr.trims,
        trims_not: lr.trims_not ?? false,
        body_styles: lr.body_styles,
        fuel: lr.fuel,
        fuel_not: lr.fuel_not ?? false,
        year_condition: lr.year_condition ?? 0,
        year_value: lr.year_value,
        miles_condition: lr.miles_condition ?? 0,
        miles_value: lr.miles_value,
        msrp_condition: lr.msrp_condition ?? 0,
        msrp1: lr.msrp1,
        msrp2: lr.msrp2,
        apply_when_no_msrp: lr.apply_when_no_msrp ?? false,
      };
      const existingRules = libRulesByName.get(name);
      if (existingRules) existingRules.push(ruleRow);
      else libRulesByName.set(name, [ruleRow]);
    }
  }
  // Live Required/Suggested flag — the library's current value always wins
  // over the value cached on vehicle_options at save time.
  const liveRequired = buildLiveRequiredByName(dealerLib);

  // ── Options from Supabase ─────────────────────────────────────────────────
  // Check per-vehicle UUID first; fall back to legacy '0' sentinel.
  // options_saved_at (migration 148): when the operator has EXPLICITLY saved
  // this vehicle's options — even an empty set — zero rows means "print no
  // dealer options", NOT "never saved": skip the sentinel fallback and the
  // library seed below (the Napleton Transit mis-print: deleting every
  // dealer product then printing re-seeded Wheel Locks + 3M and inflated
  // the asking price by $973).
  //
  // Each stage is pruned of orphaned source:"default" rows (library product
  // deleted → snapshot must not print; Jenkins Traverse 2026-08-31), and the
  // cascade advances on PRUNED emptiness — a fully-orphaned set behaves like
  // never-saved and falls through to the current-library seed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type SavedOptRow = any; // select("*") rows — same loose shape the sites below always consumed
  const libNames = libraryNameSet(dealerLib);
  // Stable library identity (migration 152) — a renamed library product still
  // resolves by id, so its saved snapshots survive the prune and render the
  // library's CURRENT name.
  const libIds = libraryIdSet(dealerLib);
  const libNameById = libraryNameById(dealerLib);
  const { data: uuidRows } = await admin
    .from("vehicle_options")
    .select("*")
    .eq("vehicle_id", dealerVehicleId)
    .eq("dealer_id", dv.dealer_id)
    .order("sort_order");
  let optionRows: SavedOptRow[] = pruneOrphanedDefaultRows(
    (uuidRows ?? []) as Array<{ option_name: string; source?: string | null; default_id?: string | null }>, libNames, libIds);

  if (optionRows.length === 0 && !optionsExplicitlySaved) {
    const { data: legacyRows } = await admin
      .from("vehicle_options")
      .select("*")
      .eq("vehicle_id", "0")
      .eq("dealer_id", dv.dealer_id)
      .order("sort_order");
    optionRows = pruneOrphanedDefaultRows(
      (legacyRows ?? []) as Array<{ option_name: string; source?: string | null; default_id?: string | null }>, libNames, libIds);
  }


  // ── Vehicle data shaped for PDF renderer ──────────────────────────────────
  const vehicleData = {
    id: 0 as const,
    DEALER_ID: dv.dealer_id,
    VIN_NUMBER: dv.vin ?? "",
    STOCK_NUMBER: dv.stock_number,
    YEAR: dv.year ? String(dv.year) : null,
    MAKE: dv.make,
    MODEL: dv.model,
    TRIM: dv.trim,
    ELECTRIFICATION: (dv as { electrification?: string | null }).electrification ?? null,
    BODYSTYLE: dv.body_style,
    EXT_COLOR: dv.exterior_color,
    INT_COLOR: dv.interior_color,
    ENGINE: dv.engine,
    FUEL: dv.fuel ?? null,
    DRIVETRAIN: dv.drivetrain,
    TRANSMISSION: dv.transmission,
    MILEAGE: dv.mileage != null ? String(dv.mileage) : null,
    DATE_IN_STOCK: dv.date_added,
    STATUS: "1" as const,
    MSRP: dv.msrp != null ? String(dv.msrp) : null,
    NEW_USED: dv.condition === "Used" ? "Used" : "New",
    CERTIFIED: vehicleConditionFields(dv).CERTIFIED,
    OPTIONS: null,
    PHOTOS: null,
    DESCRIPTION: dv.description,
    PRINT_STATUS: "0" as const,
    HMPG: dv.hmpg ?? null,
    CMPG: dv.cmpg ?? null,
    MPG: dv.mpg ?? null,
  };

  // ── Corporate (group) products, rules-filtered for this vehicle ──────────
  const groupOpts = await getGroupOptionsForDealer(textDealerId, vehicleData, dealerVehicleId);

  // Drop saved options whose library row exists but doesn't match this
  // vehicle. Custom saves (no library row), applies_to='none' manual-only
  // products, and "-NONE" auto-add sentinels are kept — shared gate with
  // the options GET and pdf/bulk (savedRowSurvivesLibraryRules).
  const savedFiltered = (optionRows ?? []).filter(r =>
    savedRowSurvivesLibraryRules(
      libRulesByName.get(normalizeOptionName(r.option_name as string)) ?? [], vehicleData, r.option_name as string,
      { option_price: (r.option_price as string | null) ?? null, default_id: (r.default_id as string | null) ?? null, source: r.source as string | null ?? null },
    )
  );

  // Library products added AFTER this vehicle's last save that rules-match
  // it print too — same merge as the options GET, so Print Now includes a
  // newly-added product without requiring an editor visit. Removed products
  // predate the save and are not resurrected.
  const freshLibOptions = newlyAddedLibraryMatches(
    dealerLib,
    (optionRows ?? []) as Array<{ option_name: string; created_at?: string | null; updated_at?: string | null }>,
    vehicleData,
  );

  // Never-saved SEED: when the vehicle has NO saved options, render the matched
  // dealer-library set (source:"default"), exactly as the options GET editor +
  // pdf/bulk do — single-generate previously printed group-only for these.
  // applies_to='none' manual-only products are excluded (never auto-add);
  // legacy addendum_data vehicles are left to that path (the save-on-print
  // guard skips persisting them so the feed keeps its authoritative values).
  const seededMatches = (optionRows ?? []).length === 0 && !optionsExplicitlySaved
    ? autoMatchedLibraryRows(dealerLib, vehicleData)
    : [];
  // Save-on-print legacy guard (checked at generation, before recordPrint
  // writes its own addendum_data): if this never-saved vehicle has legacy
  // addendum_data, the seed renders on the PDF but is NOT persisted — the feed
  // keeps its authoritative addendum_data values (2026-07-31 regression class).
  const legacyAddendumPresent = seededMatches.length > 0
    ? await hasLegacyAddendumData(admin, dv.dealer_id, dv.vin)
    : false;

  const savedFilteredMapped = savedFiltered.map(r => {
    // Library-tracked rows render the library's CURRENT name (so a rename
    // propagates); manual rows keep their own. Every library-side lookup
    // below keys off that resolved name, not the possibly-stale saved one.
    const name = liveOptionName(r as { option_name: string; source?: string | null; default_id?: string | null }, libNameById);
    const key = normalizeOptionName(name);
    const layout = libLayoutMap[key];
    const live = liveRequired.get(key);
    return {
      ...r,
      option_name: name,
      description: r.description ?? libDescMap[key] ?? null,
      // Live library type wins over the value cached at save time; the
      // saved flag only applies to custom one-offs with no library row.
      required: live !== undefined ? live : (r.required as boolean | undefined) !== false,
      separator_above: layout?.separator_above === true,
      separator_below: layout?.separator_below === true,
      spaces: layout?.spaces ?? 0,
    };
  });

  const seededMapped = seededMatches.map(r => {
    const layout = libLayoutMap[normalizeOptionName(r.option_name)];
    return {
      option_name: r.option_name,
      option_price: r.option_price,
      description: r.description,
      active: true as const,
      required: r.required,
      separator_above: layout?.separator_above === true,
      separator_below: layout?.separator_below === true,
      spaces: layout?.spaces ?? 0,
    };
  });

  const freshLibMapped = freshLibOptions.map(r => ({
    option_name: r.option_name,
    option_price: r.item_price ?? "NC",
    description: r.description ?? null,
    active: true as const,
    required: r.required !== false,
    separator_above: r.separator_above === true,
    separator_below: r.separator_below === true,
    spaces: typeof r.spaces === "number" ? r.spaces : 0,
  }));

  const options = [
    ...groupOpts.map(g => ({
      option_name: g.option_name,
      option_price: g.option_price,
      description: g.description,
      active: true as const,
      // Honor the corporate product's Required/Suggested flag — locked-assigned
      // Suggested products are still rendered in the Suggested section.
      required: g.required,
      separator_above: g.separator_above === true,
      separator_below: g.separator_below === true,
      spaces: g.spaces ?? 0,
    })),
    ...savedFilteredMapped,
    ...freshLibMapped,
    ...seededMapped,
  ];

  // Save-on-print: the NON-group set to persist on confirm (saved-surviving +
  // newly-added + seed). Group products are excluded — they merge at read time.
  const saveOptions: SaveOption[] = [
    ...savedFilteredMapped.map(r => ({
      option_name: r.option_name as string,
      option_price: (r.option_price as string | null) ?? "NC",
      description: (r.description as string | null) ?? null,
      required: (r.required as boolean | undefined) !== false,
      source: ((r as { source?: string }).source) ?? "default",
      // Carry the library identity through the print-confirm re-save
      // (migration 152) so it is not blanked back to name matching.
      default_id: (r as { default_id?: string | null }).default_id ?? null,
    })),
    ...freshLibMapped.map(r => ({
      option_name: r.option_name,
      option_price: r.option_price,
      description: r.description,
      required: r.required,
      source: "default",
      default_id: (r as { id?: unknown }).id != null ? String((r as { id?: unknown }).id) : null,
    })),
    ...(legacyAddendumPresent ? [] : seededMapped.map(r => ({
      option_name: r.option_name,
      option_price: r.option_price,
      description: r.description,
      required: r.required,
      source: "default",
      default_id: (r as { default_id?: string | null }).default_id ?? null,
    }))),
  ];

  return { vehicleData, options, saveOptions };
}
