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
import { savedRowSurvivesLibraryRules, normalizeSentinelList, matchesRulesRow, normalizeOptionName, buildLiveRequiredByName, newlyAddedLibraryMatches, libraryNameSet, pruneOrphanedDefaultRows } from "@/lib/options-engine";
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

// ── 2026-07-13 Napleton type-sync fixes ──────────────────────────────────────

void test("normalizeOptionName strips trailing legacy '^' + trims + lowercases", () => {
  assert.equal(normalizeOptionName("AVC Appearance^"), "avc appearance");
  assert.equal(normalizeOptionName("  LuxCare^^ "), "luxcare");
  assert.equal(normalizeOptionName("AVC Appearance"), "avc appearance");
  assert.equal(normalizeOptionName("KARR"), "karr");
  assert.equal(normalizeOptionName(null), "");
  // caret only strips at the END — an interior caret is part of the name
  assert.equal(normalizeOptionName("A^B"), "a^b");
});

void test("buildLiveRequiredByName: library value wins, caret-insensitive key", () => {
  const map = buildLiveRequiredByName([
    { option_name: "AVC Appearance^", required: false, active: true },
    { option_name: "Nitro Fill", required: true, active: true },
  ]);
  assert.equal(map.get(normalizeOptionName("AVC Appearance")), false); // saved name has no caret
  assert.equal(map.get(normalizeOptionName("Nitro Fill")), true);
  assert.equal(map.get(normalizeOptionName("Unknown Custom")), undefined);
});

void test("buildLiveRequiredByName: active duplicate beats inactive", () => {
  const map = buildLiveRequiredByName([
    { option_name: "Tint", required: true, active: false },
    { option_name: "Tint", required: false, active: true },
  ]);
  assert.equal(map.get("tint"), false);
});

const libNew = {
  ...baseRule,
  applies_to: "all" as string | null,
  option_name: "LuxCare^",
  active: true as boolean | null,
  created_at: "2026-07-13T16:02:02Z" as string | null,
};
const savedOld = [
  { option_name: "AVC Appearance", created_at: "2026-05-03T11:02:37Z", updated_at: "2026-05-03T11:02:37Z" },
];

void test("newlyAddedLibraryMatches: product created after last save merges in", () => {
  const fresh = newlyAddedLibraryMatches([libNew], savedOld, vehicle());
  assert.deepEqual(fresh.map(r => r.option_name), ["LuxCare^"]);
});

void test("newlyAddedLibraryMatches: product predating the save (user-removed) stays out", () => {
  const removed = { ...libNew, option_name: "Bumperdillo^", created_at: "2026-05-01T00:00:00Z" };
  assert.deepEqual(newlyAddedLibraryMatches([removed], savedOld, vehicle()), []);
});

void test("newlyAddedLibraryMatches: same name as a saved row never duplicates (caret-insensitive)", () => {
  const sameName = { ...libNew, option_name: "AVC Appearance^" };
  assert.deepEqual(newlyAddedLibraryMatches([sameName], savedOld, vehicle()), []);
});

void test("newlyAddedLibraryMatches: inactive, applies_to='none', and rule-mismatched rows stay out", () => {
  const inactive = { ...libNew, active: false };
  const manualOnly = { ...libNew, option_name: "Manual Only", applies_to: "none" as string | null };
  const wrongMake = { ...libNew, option_name: "Ford Thing", applies_to: "rules" as string | null, makes: "FORD" as string | null };
  assert.deepEqual(newlyAddedLibraryMatches([inactive, manualOnly, wrongMake], savedOld, vehicle()), []);
});

void test("newlyAddedLibraryMatches: no saved rows → no merge (seed path owns that case)", () => {
  assert.deepEqual(newlyAddedLibraryMatches([libNew], [], vehicle()), []);
});

// ── pruneOrphanedDefaultRows (orphaned library snapshots must not print) ──────

void test("pruneOrphanedDefaultRows: default row with no library def drops (deleted product)", () => {
  const names = libraryNameSet([{ option_name: "Private Tag Agency" }]);
  const rows = [
    { option_name: "All Weather Mats", source: "default" },
    { option_name: "Market Adjustment", source: "default" },
    { option_name: "Private Tag Agency", source: "default" },
  ];
  assert.deepEqual(pruneOrphanedDefaultRows(rows, names).map(r => r.option_name), ["Private Tag Agency"]);
});

void test("pruneOrphanedDefaultRows: manual one-offs always survive", () => {
  const names = libraryNameSet([]);
  const rows = [{ option_name: "Hand-typed special", source: "manual" }];
  assert.deepEqual(pruneOrphanedDefaultRows(rows, names).map(r => r.option_name), ["Hand-typed special"]);
});

void test("pruneOrphanedDefaultRows: name match is caret- and case-insensitive", () => {
  const names = libraryNameSet([{ option_name: "AVC Appearance^" }]);
  const rows = [{ option_name: "avc appearance", source: "default" }];
  assert.equal(pruneOrphanedDefaultRows(rows, names).length, 1);
});

void test("pruneOrphanedDefaultRows: fully-orphaned set prunes to empty (never-saved semantics)", () => {
  const names = libraryNameSet([{ option_name: "Jenkins Value Package" }]);
  const rows = [
    { option_name: "Wheel Locks", source: "default" },
    { option_name: "C8 Car Cover", source: "default" },
  ];
  assert.deepEqual(pruneOrphanedDefaultRows(rows, names), []);
});

// ── report ───────────────────────────────────────────────────────────────────
setTimeout(() => {
  const failed = results.filter(r => !r.ok);
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.err ? ` — ${r.err}` : ""}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}, 0);
