// Curated canonical fuel categories for the product-assignment Fuel rule.
//
// dealer_vehicles.fuel is hopelessly polluted (428 distinct values: HTML,
// numbers, colors, marketing copy), so the Fuel dropdown does NOT scan it.
// Instead it shows these clean labels; selecting a label stores that category's
// lowercase substring KEYWORDS into the `fuel` rule CSV. The matcher
// (lib/options-engine.ts listMatchesWithNot → vehicleFuel.toLowerCase().
// includes(keyword)) then catches all the feed variants.
//
// Keyword sets were built from the ~20–30 REAL fuel strings the distinct scan
// of dealer_vehicles.fuel actually returned (2026-06-09), e.g.:
//   Gasoline    ← GAS, Gasoline, Gasoline Fuel, Gasoline/E85, Regular/Premium Unleaded, UNL
//   Diesel      ← Diesel, Diesel Fuel, BIO DIESEL, DSL, Diesel/B20 Capable
//   Hybrid      ← Hybrid, Hybrid Fuel, Full Hybrid Electric, HEV/MHEV, HYBR, Gas/Electric Hybrid
//   Plug-in HEV ← PHEV (plug-in hybrid), Plug-in Hybrid, Plug-In Electric/Gas, full plug-in
//   Electric    ← Electric, Battery Electric, BEV, ELEC, Electric Fuel System
//   Flex Fuel   ← FLEX, Flex Fuel, Flex-fuel, FLEXFUEL, Flexible (Fuel), Gasoline/E85
//   Hydrogen    ← GHYD (+ FCEV / fuel cell for feeds that spell it out)
//   CNG         ← GCNG, …/CNG/…  (+ "compressed natural")
//   Propane     ← …/LPG  (+ "propane")
//
// Keywords are substrings, so "gas" catches GAS/Gasoline/Gasoline Fuel, "hev"
// catches HEV/MHEV, etc. Single-letter feed codes (D/E/G/H) are intentionally
// NOT keywords — too short to match safely.

export interface FuelRuleOption {
  label: string;
  keywords: string[];
}

export const FUEL_RULE_OPTIONS: FuelRuleOption[] = [
  { label: "Gasoline",       keywords: ["gas", "unleaded", "unl"] },
  { label: "Diesel",         keywords: ["diesel", "dsl"] },
  { label: "Hybrid",         keywords: ["hybrid", "hybr", "hev"] },
  { label: "Plug-in Hybrid", keywords: ["plug-in", "plugin", "phev"] },
  { label: "Electric",       keywords: ["electric", "elec", "bev"] },
  { label: "Flex Fuel",      keywords: ["flex", "e85", "ffv"] },
  { label: "Hydrogen",       keywords: ["hydrogen", "fcev", "fuel cell", "ghyd"] },
  { label: "CNG",            keywords: ["cng", "compressed natural"] },
  { label: "Propane",        keywords: ["propane", "lpg"] },
];
