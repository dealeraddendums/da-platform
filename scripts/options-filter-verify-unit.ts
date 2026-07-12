/**
 * Saved-option library-rules gate — committed, deterministic unit tests
 * (no DB, no network, no env).
 * Run: `npm run test:options-filter`  (or `npx tsx scripts/options-filter-verify-unit.ts`)
 *
 * Regression coverage for the 2026-07-08 TestFlight bug: a manually-added
 * product whose addendum_library row has applies_to='none' (manual-only,
 * never auto-add) was persisted to vehicle_options but silently dropped by
 * the read/print filters (options GET, pdf/generate, pdf/bulk) — and the
 * next bulk save, built from the filtered read, deleted it permanently.
 *
 * All three routes now share savedRowSurvivesLibraryRules; these tests pin
 * its contract:
 *   - applies_to='none' rows always survive (the bug)
 *   - "-NONE"/"NONE"/empty list sentinels don't drop saved rows (ABT fix)
 *   - genuine rule mismatches still drop (2026-05-13 design)
 *   - duplicate same-name library rows: any one match keeps the row (KARR fix)
 *   - no library definition (custom one-off) survives
 */
import assert from "node:assert/strict";
import { savedRowSurvivesLibraryRules, normalizeSentinelList, matchesRulesRow } from "@/lib/options-engine";
import type { VehicleRow } from "@/lib/vehicles";

// ── tiny test runner ─────────────────────────────────────────────────────────
const results: { name: string; ok: boolean; err?: string }[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e instanceof Error ? e.message : String(e) }); }
}

function vehicle(p: Partial<VehicleRow> = {}): VehicleRow {
  return {
    id: 0, DEALER_ID: "test-dealer", VIN_NUMBER: "1HGCM82633A004352",
    STOCK_NUMBER: "T-1", YEAR: "2024", MAKE: "Honda", MODEL: "Civic",
    TRIM: "EX", BODYSTYLE: "Sedan", EXT_COLOR: null, INT_COLOR: null,
    ENGINE: null, FUEL: null, DRIVETRAIN: null, TRANSMISSION: null,
    MILEAGE: "10", DATE_IN_STOCK: null, STATUS: "1", MSRP: "30000",
    NEW_USED: "New", CERTIFIED: "No", OPTIONS: null, PHOTOS: null,
    DESCRIPTION: null, PRINT_STATUS: "0", HMPG: null, CMPG: null, MPG: null,
    ...p,
  } as VehicleRow;
}

const baseRule = {
  applies_to: "rules" as string | null,
  ad_types: ["New", "Used"] as string[] | null,
  makes: null as string | null, makes_not: false,
  models: null as string | null, models_not: false,
  trims: null as string | null, trims_not: false,
  body_styles: null as string | null,
  year_condition: 0, year_value: null as number | null,
  miles_condition: 0, miles_value: null as number | null,
  msrp_condition: 0, msrp1: null as number | null, msrp2: null as number | null,
};

// ── the 2026-07-08 bug: applies_to='none' must never drop a saved row ───────
void test("applies_to='none' (manual-only product) survives", () => {
  assert.equal(savedRowSurvivesLibraryRules([{ ...baseRule, applies_to: "none" }], vehicle()), true);
});

void test("applies_to='none' survives even with a hostile rules body", () => {
  // 'none' rows keep whatever stale filter values the UI left behind.
  assert.equal(savedRowSurvivesLibraryRules(
    [{ ...baseRule, applies_to: "none", ad_types: ["Used"], makes: "FERRARI" }],
    vehicle({ MAKE: "Honda", NEW_USED: "New" })
  ), true);
});

void test("sanity: matchesRulesRow itself still rejects applies_to='none' (auto-add path unchanged)", () => {
  assert.equal(matchesRulesRow({ ...baseRule, applies_to: "none" }, vehicle()), false);
});

// ── custom one-offs and matches survive ─────────────────────────────────────
void test("no library definition (custom one-off) survives", () => {
  assert.equal(savedRowSurvivesLibraryRules([], vehicle()), true);
});

void test("matching 'all' rule survives", () => {
  assert.equal(savedRowSurvivesLibraryRules([{ ...baseRule, applies_to: "all" }], vehicle()), true);
});

// ── genuine mismatches still drop (library rules trump saved state) ─────────
void test("genuine make mismatch drops", () => {
  assert.equal(savedRowSurvivesLibraryRules(
    [{ ...baseRule, makes: "CHEVROLET" }], vehicle({ MAKE: "Honda" })
  ), false);
});

void test("genuine ad_type mismatch drops", () => {
  assert.equal(savedRowSurvivesLibraryRules(
    [{ ...baseRule, ad_types: ["Used"] }], vehicle({ NEW_USED: "New" })
  ), false);
});

// ── "-NONE"/"NONE"/empty sentinels never drop (ABT fix, all read sites) ─────
void test("'-NONE' sentinel in models/trims/body_styles doesn't drop", () => {
  assert.equal(savedRowSurvivesLibraryRules(
    [{ ...baseRule, models: "-NONE", trims: "-NONE", body_styles: "-NONE" }], vehicle()
  ), true);
});

void test("'NONE' sentinel in makes doesn't drop", () => {
  assert.equal(savedRowSurvivesLibraryRules([{ ...baseRule, makes: "NONE" }], vehicle()), true);
});

void test("genuine list filter still applies alongside sentinel fields", () => {
  assert.equal(savedRowSurvivesLibraryRules(
    [{ ...baseRule, models: "-NONE", makes: "CHEVROLET" }], vehicle({ MAKE: "Honda" })
  ), false);
});

// ── duplicate same-name library rows (KARR fix) ─────────────────────────────
void test("duplicate rows: one match among duplicates keeps the row", () => {
  assert.equal(savedRowSurvivesLibraryRules([
    { ...baseRule, ad_types: ["Used"] },          // mismatched duplicate
    { ...baseRule, applies_to: "all" },           // the real product
  ], vehicle({ NEW_USED: "New" })), true);
});

void test("duplicate rows: all mismatched drops", () => {
  assert.equal(savedRowSurvivesLibraryRules([
    { ...baseRule, ad_types: ["Used"] },
    { ...baseRule, makes: "FERRARI" },
  ], vehicle({ NEW_USED: "New", MAKE: "Honda" })), false);
});

// ── normalizeSentinelList contract ───────────────────────────────────────────
void test("normalizeSentinelList collapses sentinels, preserves real lists", () => {
  assert.equal(normalizeSentinelList("-NONE"), null);
  assert.equal(normalizeSentinelList("NONE"), null);
  assert.equal(normalizeSentinelList("none"), null);
  assert.equal(normalizeSentinelList(""), null);
  assert.equal(normalizeSentinelList("  "), null);
  assert.equal(normalizeSentinelList(", ,"), null);
  assert.equal(normalizeSentinelList(null), null);
  assert.equal(normalizeSentinelList(undefined), null);
  assert.equal(normalizeSentinelList("KARR"), "KARR");
  assert.equal(normalizeSentinelList("ALL"), "ALL");
  assert.equal(normalizeSentinelList("Civic,Accord"), "Civic,Accord");
});

// ── N≥2 manual options all survive the read/print gate (bug shape) ──────────
void test("2 manual adds: 'all' product + 'none' product BOTH survive", () => {
  const rulesByName = new Map<string, (typeof baseRule)[]>([
    ["Ceramic Tint", [{ ...baseRule, applies_to: "all" }]],
    ["Wheel Locks", [{ ...baseRule, applies_to: "none" }]],
  ]);
  const saved = [
    { option_name: "Ceramic Tint" },
    { option_name: "Wheel Locks" },
    { option_name: "One-Off Custom Thing" }, // no library row
  ];
  const kept = saved.filter(r => savedRowSurvivesLibraryRules(rulesByName.get(r.option_name) ?? [], vehicle()));
  assert.deepEqual(kept.map(r => r.option_name), ["Ceramic Tint", "Wheel Locks", "One-Off Custom Thing"]);
});

// ── report ───────────────────────────────────────────────────────────────────
setTimeout(() => {
  const failed = results.filter(r => !r.ok);
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.err ? ` — ${r.err}` : ""}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}, 0);
