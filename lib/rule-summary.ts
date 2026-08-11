// Human-readable summary of a product's vehicle rules (2026-08-11).
//
// Renders the SAME fields matchesRulesRow (lib/options-engine.ts) evaluates,
// with the same semantics, so the summary can never drift from matching
// behavior:
//   • applies_to='none'      → manual-only, never auto-applied
//   • ad_types               → condition filter (New/Used/CPO); empty = all
//   • makes/models/trims/fuel + *_not → IN / NOT-IN lists ("-NONE"/"NONE"/
//     empty collapse to "no restriction", mirroring normalizeSentinelList)
//   • body_styles            → IN list (engine has no NOT for bodystyle)
//   • year_condition  1/2/3  → = V · V-or-older · V-or-newer (the engine's
//     comparisons are inclusive, so "2024 or older" — the authoring UI's
//     "Before" label — includes 2024 itself)
//   • miles_condition 1/2    → under V · over V (inclusive at the boundary)
//   • msrp_condition  1/2/3  → under $V · over $V · $V1–$V2
//
// Shared by the Products-list tooltips (dealer own + corporate, group
// Corporate Products tab); also suitable for the import/export diff views
// and the authoring modals.

// NOTE: deliberately NOT importing from lib/options-engine — that module is
// server-only (pulls the admin Supabase client) and this helper renders in
// client components. The sentinel collapse below is a faithful copy of
// options-engine's normalizeSentinelList — keep the two in sync.
function normalizeSentinelList(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim().toUpperCase();
  if (t === "" || t === "-NONE" || t === "NONE") return null;
  if (v.split(",").map((s) => s.trim()).filter(Boolean).length === 0) return null;
  return v;
}

export interface RuleSummaryRow {
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
}

const fmtNum = (n: number): string => n.toLocaleString("en-US");
const fmtMoney = (n: number): string => `$${n.toLocaleString("en-US")}`;

function listPhrase(label: string, raw: string | null | undefined, notFlag?: boolean | null): string | null {
  const v = normalizeSentinelList(raw);
  if (!v) return null;
  const items = v.split(",").map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) return null;
  return `${label}: ${notFlag ? "NOT " : ""}${items.join(", ")}`;
}

/** Ordered list of plain-English rule phrases. Empty array = no rules set. */
export function summarizeRules(row: RuleSummaryRow): string[] {
  if (row.applies_to === "none") {
    return ["Manual only — never auto-applied to vehicles"];
  }
  const out: string[] = [];

  const adTypes = (row.ad_types ?? []).filter(Boolean);
  // Empty = all conditions (matchesAdTypes); listing all three is the same.
  if (adTypes.length > 0 && adTypes.length < 3) {
    out.push(adTypes.length === 1 ? `${adTypes[0]} only` : adTypes.join(", "));
  }

  const make = listPhrase("Make", row.makes, row.makes_not);
  if (make) out.push(make);
  const model = listPhrase("Model", row.models, row.models_not);
  if (model) out.push(model);
  const trim = listPhrase("Trim", row.trims, row.trims_not);
  if (trim) out.push(trim);
  const body = listPhrase("Bodystyle", row.body_styles, false);
  if (body) out.push(body);
  const fuel = listPhrase("Fuel", row.fuel, row.fuel_not);
  if (fuel) out.push(fuel);

  const yc = row.year_condition ?? 0;
  if (yc !== 0 && row.year_value != null) {
    if (yc === 1) out.push(`Year = ${row.year_value}`);
    else if (yc === 2) out.push(`Year ${row.year_value} or older`);
    else if (yc === 3) out.push(`Year ${row.year_value} or newer`);
  }

  const mc = row.miles_condition ?? 0;
  if (mc !== 0 && row.miles_value != null) {
    if (mc === 1) out.push(`Mileage under ${fmtNum(row.miles_value)}`);
    else if (mc === 2) out.push(`Mileage over ${fmtNum(row.miles_value)}`);
  }

  const pc = row.msrp_condition ?? 0;
  if (pc !== 0) {
    if (pc === 1 && row.msrp1 != null) out.push(`MSRP under ${fmtMoney(row.msrp1)}`);
    else if (pc === 2 && row.msrp1 != null) out.push(`MSRP over ${fmtMoney(row.msrp1)}`);
    else if (pc === 3 && row.msrp1 != null && row.msrp2 != null) out.push(`MSRP ${fmtMoney(row.msrp1)}–${fmtMoney(row.msrp2)}`);
  }

  return out;
}

export const NO_RULES_TEXT = "Applies to all vehicles — no rules.";
