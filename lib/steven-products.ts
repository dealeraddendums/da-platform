// Steven S2 — "why does / doesn't this product apply to THIS vehicle".
//
// The applied set is assembled with the SAME exported engine functions, in the
// SAME order, as the single-vehicle print path (app/api/pdf/generate): saved
// rows pruned of orphans → legacy '0' sentinel fallback → saved rows gated by
// savedRowSurvivesLibraryRules → library products added after the last save
// (newlyAddedLibraryMatches) → never-saved seed (autoMatchedLibraryRows) →
// corporate products (getGroupOptionsForDealer). The "why not" for a product
// comes from explainRulesRow — the one implementation matchesRulesRow itself
// delegates to — so the explanation can't disagree with the print.
//
// Callers pass a dealer id that lib/steven-tools.ts already resolved from the
// SESSION; the vehicle lookup below is pinned to that dealer, so a VIN or
// stock number from another dealer is simply not found.
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { createAdminSupabaseClient } from "@/lib/db";
import {
  explainRulesRow, savedRowSurvivesLibraryRules, normalizeOptionName, buildLiveRequiredByName,
  newlyAddedLibraryMatches, autoMatchedLibraryRows, libraryNameSet, libraryIdSet, libraryNameById, liveOptionName,
  pruneOrphanedDefaultRows, getGroupOptionsForDealer,
} from "@/lib/options-engine";
import { formatOptionPrice } from "@/lib/option-price";
import { vehicleConditionFields, vehicleCondition } from "@/lib/vehicles";

type Admin = ReturnType<typeof createAdminSupabaseClient>;

const LIB_COLS = "id, option_name, item_price, description, required, active, created_at, sort_order, separator_above, separator_below, spaces, applies_to, ad_types, makes, makes_not, models, models_not, trims, trims_not, body_styles, fuel, fuel_not, year_condition, year_value, miles_condition, miles_value, msrp_condition, msrp1, msrp2, apply_when_no_msrp";

function ruleRow(lr: any) {
  return {
    id: lr.id ?? null, option_name: lr.option_name ?? null, item_price: lr.item_price ?? null,
    applies_to: lr.applies_to, ad_types: lr.ad_types,
    makes: lr.makes, makes_not: lr.makes_not ?? false, models: lr.models, models_not: lr.models_not ?? false,
    trims: lr.trims, trims_not: lr.trims_not ?? false, body_styles: lr.body_styles, fuel: lr.fuel, fuel_not: lr.fuel_not ?? false,
    year_condition: lr.year_condition ?? 0, year_value: lr.year_value,
    miles_condition: lr.miles_condition ?? 0, miles_value: lr.miles_value,
    msrp_condition: lr.msrp_condition ?? 0, msrp1: lr.msrp1, msrp2: lr.msrp2, apply_when_no_msrp: lr.apply_when_no_msrp ?? false,
  };
}

/** Same vehicle shape pdf/generate hands the engine. */
function vehicleData(dv: any) {
  return {
    id: 0 as const, DEALER_ID: dv.dealer_id, VIN_NUMBER: dv.vin ?? "", STOCK_NUMBER: dv.stock_number,
    YEAR: dv.year ? String(dv.year) : null, MAKE: dv.make, MODEL: dv.model, TRIM: dv.trim, BODYSTYLE: dv.body_style,
    EXT_COLOR: dv.exterior_color, INT_COLOR: dv.interior_color, ENGINE: dv.engine, FUEL: dv.fuel ?? null,
    DRIVETRAIN: dv.drivetrain, TRANSMISSION: dv.transmission, MILEAGE: dv.mileage != null ? String(dv.mileage) : null,
    DATE_IN_STOCK: dv.date_added, STATUS: "1" as const, MSRP: dv.msrp != null ? String(dv.msrp) : null,
    NEW_USED: dv.condition === "Used" ? "Used" : "New", CERTIFIED: vehicleConditionFields(dv).CERTIFIED,
    OPTIONS: null, PHOTOS: null, DESCRIPTION: dv.description, PRINT_STATUS: "0" as const,
    HMPG: dv.hmpg ?? null, CMPG: dv.cmpg ?? null, MPG: dv.mpg ?? null,
  };
}

/** The dealer's OWN vehicle by VIN (full, or last 6–8) or stock number. */
export async function findOwnVehicle(admin: Admin, dealerId: string, ref: string): Promise<
  { ok: true; dv: any } | { ok: false; message: string }
> {
  const r = (ref || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
  if (r.length < 3) return { ok: false, message: "Need a VIN (full or last 6+ characters) or a stock number." };
  const base = () => (admin as any).from("dealer_vehicles").select("*").eq("dealer_id", dealerId);
  let rows: any[] = [];
  const exact = await base().or(`vin.ilike.${r},stock_number.ilike.${r}`).limit(5);
  rows = exact.data ?? [];
  if (!rows.length && r.length >= 6) {
    const tail = await base().ilike("vin", `%${r}`).limit(5);
    rows = tail.data ?? [];
  }
  if (!rows.length) return { ok: false, message: "No vehicle with that VIN or stock number in this dealership's inventory." };
  const active = rows.filter((v) => v.status === "active");
  const pick = active.length ? active : rows;
  if (pick.length > 1) {
    return { ok: false, message: `More than one vehicle matches: ${pick.map((v) => `${v.stock_number ?? "?"} (${v.vin ?? "no VIN"})`).join("; ")}. Ask which one.` };
  }
  return { ok: true, dv: pick[0] };
}

export async function explainVehicleProducts(admin: Admin, dealerId: string, ref: string, productName?: string | null) {
  const found = await findOwnVehicle(admin, dealerId, ref);
  if (!found.ok) return { error: found.message, not_found: true };
  const dv = found.dv;
  const v = vehicleData(dv);
  const a = admin as any;

  // ── Library (whole, like the print path) ──
  const { data: libData } = await a.from("addendum_library").select(LIB_COLS).eq("dealer_id", dealerId).order("sort_order", { ascending: true });
  const lib = (libData ?? []) as any[];
  const libRulesByName = new Map<string, any[]>();
  for (const lr of lib) {
    const k = normalizeOptionName(lr.option_name);
    const arr = libRulesByName.get(k); if (arr) arr.push(ruleRow(lr)); else libRulesByName.set(k, [ruleRow(lr)]);
  }
  const liveRequired = buildLiveRequiredByName(lib);
  const libNames = libraryNameSet(lib), libIds = libraryIdSet(lib), libNameById = libraryNameById(lib);
  const explicitlySaved = Boolean(dv.options_saved_at);

  // ── Saved rows → sentinel fallback (pruned) ──
  const { data: uuidRows } = await a.from("vehicle_options").select("*").eq("vehicle_id", dv.id).eq("dealer_id", dealerId).order("sort_order");
  let saved = pruneOrphanedDefaultRows((uuidRows ?? []) as any[], libNames, libIds);
  if (saved.length === 0 && !explicitlySaved) {
    const { data: legacy } = await a.from("vehicle_options").select("*").eq("vehicle_id", "0").eq("dealer_id", dealerId).order("sort_order");
    saved = pruneOrphanedDefaultRows((legacy ?? []) as any[], libNames, libIds);
  }
  const savedKept = saved.filter((r: any) => savedRowSurvivesLibraryRules(
    libRulesByName.get(normalizeOptionName(r.option_name)) ?? [], v, r.option_name,
    { option_price: r.option_price ?? null, default_id: r.default_id ?? null, source: r.source ?? null },
  ));
  const fresh = newlyAddedLibraryMatches(lib, saved as any[], v);
  const seed = saved.length === 0 && !explicitlySaved ? autoMatchedLibraryRows(lib, v) : [];
  const group = await getGroupOptionsForDealer(dealerId, v, dv.id);

  const applied = [
    ...group.map((g) => ({ name: g.option_name, price: g.option_price, required: g.required, source: "corporate (group) product" })),
    ...savedKept.map((r: any) => {
      const name = liveOptionName(r, libNameById);
      const live = liveRequired.get(normalizeOptionName(name));
      return {
        name, price: r.option_price,
        required: live !== undefined ? live : r.required !== false,
        source: r.source === "manual" ? "added to this vehicle by hand" : "your product (saved on this vehicle)",
      };
    }),
    ...fresh.map((r: any) => ({ name: r.option_name, price: r.item_price ?? "NC", required: r.required !== false, source: "your product (added since the vehicle was last saved)" })),
    ...seed.map((r) => ({ name: r.option_name, price: r.option_price, required: r.required, source: "your product (matches its rules)" })),
  ].map((x) => ({ name: x.name, price: formatOptionPrice(x.price) || String(x.price ?? ""), type: x.required ? "Required" : "Suggested", source: x.source }));

  const appliedKeys = new Set(applied.map((x) => normalizeOptionName(x.name)));
  const savedKeys = new Set(saved.map((r: any) => normalizeOptionName(liveOptionName(r, libNameById))));
  let lastSave = 0;
  for (const r of saved as any[]) for (const t of [r.created_at, r.updated_at]) { const ms = t ? Date.parse(t) : NaN; if (!Number.isNaN(ms) && ms > lastSave) lastSave = ms; }

  // ── Why NOT, for each of the dealer's products that isn't on the vehicle ──
  const whyNot: { name: string; reason: string }[] = [];
  for (const lr of lib) {
    const k = normalizeOptionName(lr.option_name);
    if (appliedKeys.has(k)) continue;
    let reason: string;
    if (lr.active === false) reason = "the product is turned off (inactive) in your Products library";
    else {
      const verdict = explainRulesRow(ruleRow(lr), v);
      if (!verdict.ok) reason = verdict.reason;
      else if (savedKeys.has(k)) reason = "it's saved on this vehicle but its rules were edited since — re-open the vehicle's products to refresh";
      else if (explicitlySaved || saved.length > 0) {
        const created = lr.created_at ? Date.parse(lr.created_at) : NaN;
        reason = !Number.isNaN(created) && created <= lastSave
          ? "this vehicle's products were saved without it (it was removed from, or never added to, this vehicle in the product editor)"
          : "this vehicle's product list was saved by hand; add it in the vehicle's product editor";
      } else reason = "it matches the rules but isn't on the vehicle — please contact support with this VIN";
    }
    whyNot.push({ name: lr.option_name, reason });
  }

  // Corporate products not on the vehicle: not assigned to this store, rules, or removed.
  const { data: dealerRow } = await a.from("dealers").select("id, group_id").eq("dealer_id", dealerId).maybeSingle();
  if (dealerRow?.group_id) {
    const { data: gRows } = await a.from("group_options").select("*").eq("group_id", dealerRow.group_id).eq("active", true);
    const groupApplied = new Set(group.map((g) => g.id));
    const notOn = ((gRows ?? []) as any[]).filter((g) => !groupApplied.has(g.id));
    if (notOn.length) {
      const { data: assigns } = await a.from("dealer_option_assignments").select("option_id")
        .eq("dealer_id", dealerRow.id).eq("group_id", dealerRow.group_id).eq("dealer_editable", false)
        .in("option_id", notOn.map((g) => g.id));
      const assigned = new Set(((assigns ?? []) as any[]).map((x) => x.option_id));
      for (const g of notOn) {
        let reason: string;
        if (g.assign_all_dealers === false && !assigned.has(g.id)) reason = "it's a corporate (group) product your group hasn't assigned to this store";
        else {
          const verdict = explainRulesRow(g, v);
          reason = verdict.ok ? "it's a corporate product that was removed from this vehicle" : verdict.reason;
        }
        whyNot.push({ name: `${g.option_name} (corporate)`, reason });
      }
    }
  }

  const want = (productName || "").trim().toLowerCase();
  const focus = want
    ? {
        asked_about: productName,
        applies: applied.filter((x) => x.name.toLowerCase().includes(want)),
        not_applied: whyNot.filter((x) => x.name.toLowerCase().includes(want)),
      }
    : null;

  return {
    vehicle: {
      stock_number: dv.stock_number, vin: dv.vin,
      description: [dv.year, dv.make, dv.model, dv.trim].filter(Boolean).join(" "),
      condition: vehicleCondition(v), msrp: dv.msrp ?? null, mileage: dv.mileage ?? null,
      body_style: dv.body_style ?? null, fuel: dv.fuel ?? null, in_inventory: dv.status === "active",
    },
    products_saved_by_hand: explicitlySaved || saved.length > 0,
    applies: applied,
    ...(focus ? { focus } : {}),
    // Every non-applying product when few; otherwise the first 25 (ask about one by name for detail).
    does_not_apply: focus ? undefined : whyNot.slice(0, 25),
    does_not_apply_total: whyNot.length,
    note: "This is the same product set Print Now uses for this vehicle.",
  };
}
