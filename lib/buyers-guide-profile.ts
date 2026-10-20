// Buyer's Guide "guide by mileage / CPO" profile selection. Pure and
// client-safe: the Buyer's Guide modal, POST /api/pdf/buyers-guide and the
// bulk route all pick the profile here, so they can never disagree.
import type { BuyersGuideDefaults, BuyersGuideWarrantyProfile } from "@/lib/db";
import { resolveVehicleCondition } from "@/lib/vehicles";

/** low = the dealer's default guide (the base buyers_guide_defaults fields). */
export type BuyersGuideSlot = "low" | "high" | "cpo";

export const BG_SLOT_LABELS: Record<BuyersGuideSlot, string> = {
  low: "Low (default)",
  high: "High mileage",
  cpo: "CPO",
};

const PROFILE_KEYS = [
  "labor_pct", "parts_pct", "systems_covered", "duration", "non_dealer_warranties",
] as const satisfies readonly (keyof BuyersGuideWarrantyProfile)[];

export type BgProfileVehicle = {
  mileage?: number | string | null;
  condition?: string | null;
  certified?: string | boolean | null;
};

/** True when the dealer's rule is live: switched on, a positive threshold,
 *  and a Limited Warranty default guide. As-Is / Implied / Full never use it. */
export function mileageRuleActive(defaults: BuyersGuideDefaults | null | undefined): boolean {
  const rule = defaults?.mileage_rule;
  return defaults?.warranty_type === "limited"
    && rule?.enabled === true
    && typeof rule.threshold === "number" && rule.threshold > 0;
}

/** Which profile the rule picks for a vehicle, or null when the rule doesn't
 *  apply. Order: CPO (certified flag, any mileage) → mileage >= threshold →
 *  Low. Unknown / zero mileage can't prove high mileage, so it is Low. */
export function selectBuyersGuideSlot(
  defaults: BuyersGuideDefaults | null | undefined,
  vehicle: BgProfileVehicle,
): BuyersGuideSlot | null {
  if (!mileageRuleActive(defaults)) return null;
  if (resolveVehicleCondition(vehicle) === "CPO") return "cpo";
  const miles = Number(vehicle.mileage);
  if (Number.isFinite(miles) && miles > 0 && miles >= (defaults!.mileage_rule!.threshold as number)) return "high";
  return "low";
}

/** The warranty to print for a slot. Low returns the defaults untouched. High
 *  and CPO are FULL profiles: every profile field is taken from the slot (a
 *  blank there prints blank, it does not inherit Low); everything else —
 *  dealer email, complaints contact, service contract, print layout — stays
 *  the dealer's. A slot never configured falls back to Low. */
export function applyBuyersGuideSlot(
  defaults: BuyersGuideDefaults,
  slot: BuyersGuideSlot | null,
): BuyersGuideDefaults {
  if (slot === null || slot === "low") return defaults;
  const profile = defaults.mileage_rule?.[slot];
  if (!profile) return defaults;
  const out: BuyersGuideDefaults = { ...defaults, warranty_type: "limited" };
  for (const k of PROFILE_KEYS) (out as Record<string, unknown>)[k] = profile[k];
  return out;
}

/** The Low profile's fields (the base defaults), so a screen that switched
 *  to High/CPO can switch back. */
export function lowProfileOf(defaults: BuyersGuideDefaults): BuyersGuideWarrantyProfile & Pick<BuyersGuideDefaults, "warranty_type"> {
  const out: Record<string, unknown> = { warranty_type: defaults.warranty_type };
  for (const k of PROFILE_KEYS) out[k] = defaults[k];
  return out as BuyersGuideWarrantyProfile & Pick<BuyersGuideDefaults, "warranty_type">;
}

/** selectBuyersGuideSlot + applyBuyersGuideSlot. */
export function resolveBuyersGuideWarranty(
  defaults: BuyersGuideDefaults,
  vehicle: BgProfileVehicle,
): { slot: BuyersGuideSlot | null; warranty: BuyersGuideDefaults } {
  const slot = selectBuyersGuideSlot(defaults, vehicle);
  return { slot, warranty: applyBuyersGuideSlot(defaults, slot) };
}
