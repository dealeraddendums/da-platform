/* npm run test:bg-profile — lib/buyers-guide-profile.ts guide by mileage / CPO */
import { resolveBuyersGuideWarranty, applyBuyersGuideSlot, lowProfileOf } from "../lib/buyers-guide-profile";
import type { BuyersGuideDefaults } from "../lib/db";

let fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`}`);
}

const high = { labor_pct: 0, parts_pct: 0, systems_covered: "Engine only", duration: "15 days\nor 500 miles", non_dealer_warranties: [] };
const cpo = { labor_pct: 100, parts_pct: 100, systems_covered: "Bumper to bumper", duration: "12 months / 12,000 miles", non_dealer_warranties: ["mfr_used"] };
const base: BuyersGuideDefaults = {
  warranty_type: "limited", labor_pct: 50, parts_pct: 50, systems_covered: "Powertrain", duration: "30 days or 1,000 miles",
  non_dealer_warranties: ["mfr_new"], dealer_email: "sales@d.com", complaints_contact: "Jane", service_contract: true,
  mileage_rule: { enabled: true, threshold: 70000, high, cpo },
};
const used = (mileage: unknown, certified: unknown = "false") => ({ mileage: mileage as number, condition: "Used", certified: certified as string });

eq("80k used → high", resolveBuyersGuideWarranty(base, used(80000)).slot, "high");
eq("exactly 70k → high (>=)", resolveBuyersGuideWarranty(base, used(70000)).slot, "high");
eq("50k used → low", resolveBuyersGuideWarranty(base, used(50000)).slot, "low");
eq("low returns defaults object untouched", resolveBuyersGuideWarranty(base, used(50000)).warranty === base, true);
eq("0 miles → low", resolveBuyersGuideWarranty(base, used(0)).slot, "low");
eq("null miles → low", resolveBuyersGuideWarranty(base, used(null)).slot, "low");
eq("garbage miles → low", resolveBuyersGuideWarranty(base, used("abc")).slot, "low");
eq("string miles '91000' → high", resolveBuyersGuideWarranty(base, used("91000")).slot, "high");
eq("CPO at 120k → cpo (CPO wins)", resolveBuyersGuideWarranty(base, used(120000, "Yes")).slot, "cpo");
eq("CPO at 5k → cpo", resolveBuyersGuideWarranty(base, used(5000, "true")).slot, "cpo");
eq("CPO unknown mileage → cpo", resolveBuyersGuideWarranty(base, used(null, "Y")).slot, "cpo");
eq("prose-fragment certified 'we o' is NOT cpo", resolveBuyersGuideWarranty(base, used(80000, "we o")).slot, "high");

const h = resolveBuyersGuideWarranty(base, used(80000)).warranty;
eq("high profile fields applied", [h.labor_pct, h.parts_pct, h.systems_covered, h.duration, h.non_dealer_warranties], [0, 0, "Engine only", "15 days\nor 500 miles", []]);
eq("high keeps dealer email/complaints/service contract", [h.dealer_email, h.complaints_contact, h.service_contract, h.warranty_type], ["sales@d.com", "Jane", true, "limited"]);
const c = resolveBuyersGuideWarranty(base, used(1, "yes")).warranty;
eq("cpo profile fields applied", [c.labor_pct, c.systems_covered, c.non_dealer_warranties], [100, "Bumper to bumper", ["mfr_used"]]);

const partial = { ...base, mileage_rule: { ...base.mileage_rule, high: { duration: "7 days" } } };
const hp = resolveBuyersGuideWarranty(partial, used(80000)).warranty;
eq("full profile: blank High field prints blank, not Low", [hp.duration, hp.systems_covered, hp.labor_pct], ["7 days", undefined, undefined]);

const noHigh = { ...base, mileage_rule: { enabled: true, threshold: 70000, cpo } };
eq("unconfigured High slot → Low fields", resolveBuyersGuideWarranty(noHigh, used(80000)).warranty === noHigh, true);

for (const wt of ["as_is", "implied_only", "full"] as const) {
  const d = { ...base, warranty_type: wt };
  const r = resolveBuyersGuideWarranty(d, used(80000, "yes"));
  eq(`${wt} → rule inert, defaults untouched`, [r.slot, r.warranty === d], [null, true]);
}
for (const [label, rule] of [
  ["disabled", { ...base.mileage_rule, enabled: false }],
  ["no threshold", { ...base.mileage_rule, threshold: null }],
  ["zero threshold", { ...base.mileage_rule, threshold: 0 }],
  ["no rule at all", undefined],
] as const) {
  const d = { ...base, mileage_rule: rule };
  const r = resolveBuyersGuideWarranty(d, used(80000, "yes"));
  eq(`${label} → rule inert, defaults untouched`, [r.slot, r.warranty === d], [null, true]);
}

// Modal manual switch back to Low restores the base profile fields.
const switched = applyBuyersGuideSlot({ ...h, ...lowProfileOf(base), mileage_rule: base.mileage_rule }, "low");
eq("manual switch High → Low restores base fields", [switched.labor_pct, switched.systems_covered, switched.non_dealer_warranties], [50, "Powertrain", ["mfr_new"]]);

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
