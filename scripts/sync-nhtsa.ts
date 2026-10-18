/**
 * sync-nhtsa.ts — Download and import NHTSA vPIC data into Supabase.
 * Run: npx tsx scripts/sync-nhtsa.ts
 * Cron: every 14 days  (0 4 1,15 * *  on EC2)
 *
 * Imports:
 *   1. All makes  (~12k records, one API call)
 *   2. Models for top common makes
 *   3. WMI records — every 3-char WMI our inventory uses + known brands',
 *      resolved per code via vPIC DecodeWMI (gives the real Make)
 *   4. Writes nhtsa_sync_log on completion
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(process.cwd(), ".env.local") });
dotenv.config({ path: path.join(process.cwd(), ".env.production") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const NHTSA_BASE = "https://vpic.nhtsa.dot.gov/api/vehicles";

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      console.warn(`  HTTP ${res.status} for ${url}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    console.warn(`  fetch error for ${url}:`, e);
    return null;
  }
}

async function upsertBatch<T extends Record<string, unknown>>(
  table: string,
  rows: T[],
  conflictCol: string
): Promise<number> {
  if (!rows.length) return 0;
  // Postgres rejects an upsert batch that touches the same key twice ("ON
  // CONFLICT DO UPDATE command cannot affect row a second time"), and vPIC
  // repeats keys (WMIs shared across brands). Last occurrence wins.
  const byKey = new Map<unknown, T>();
  for (const r of rows) byKey.set(r[conflictCol], r);
  const unique = Array.from(byKey.values());
  const BATCH = 500;
  let total = 0;
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    const { error, data } = await admin
      .from(table)
      .upsert(batch, { onConflict: conflictCol })
      .select("*");
    // A failed write fails the sync. This used to be a console.warn, which
    // let nhtsa_wmi sit at 0 rows for months behind "success" log entries.
    if (error) throw new Error(`upsert error on ${table}: ${error.message}`);
    total += data?.length ?? 0;
  }
  return total;
}

// ── Step 1: Sync all makes ────────────────────────────────────────────────────
async function syncMakes(): Promise<number> {
  console.log("Syncing makes...");
  const json = await fetchJson<{ Results: { Make_ID: number; Make_Name: string }[] }>(
    `${NHTSA_BASE}/GetAllMakes?format=json`
  );
  if (!json?.Results?.length) {
    console.warn("  No makes returned");
    return 0;
  }
  const rows = json.Results.map((r) => ({ id: r.Make_ID, name: r.Make_Name }));
  const count = await upsertBatch("nhtsa_makes", rows, "id");
  console.log(`  Synced ${count} makes`);
  return count;
}

// ── Step 2: Sync models for major makes ──────────────────────────────────────
// Names only — make IDs are resolved against nhtsa_makes at runtime so we
// don't drift when NHTSA renumbers entries. (Hardcoded IDs were wrong:
// 500 mapped to FIAT, not FORD; 559 to a 1-model entry, not real TOYOTA;
// etc., which gave only 1956 models across the catalog — the trim harvest
// then skipped 18,176 unique VINs as "no model" because Ford F-150 / Toyota
// Camry / Chevy Silverado weren't in nhtsa_models.)
const MAJOR_MAKE_NAMES = [
  "ACURA", "ALFA ROMEO", "ASTON MARTIN", "AUDI", "BENTLEY", "BMW",
  "BUICK", "CADILLAC", "CHEVROLET", "CHRYSLER", "DODGE", "FERRARI",
  "FIAT", "FORD", "GENESIS", "GMC", "HONDA", "HYUNDAI", "INFINITI",
  "JAGUAR", "JEEP", "KIA", "LAMBORGHINI", "LAND ROVER", "LEXUS",
  "LINCOLN", "LOTUS", "MASERATI", "MAZDA", "MERCEDES-BENZ", "MINI",
  "MITSUBISHI", "NISSAN", "OLDSMOBILE", "PONTIAC", "PORSCHE", "RAM",
  "RIVIAN", "ROLLS-ROYCE", "SUBARU", "TESLA", "TOYOTA", "VOLKSWAGEN",
  "VOLVO",
];

async function pageAllMakes(): Promise<{ id: number; name: string }[]> {
  const out: { id: number; name: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await admin
      .from("nhtsa_makes")
      .select("id, name")
      .order("id", { ascending: true })
      .range(from, from + 999);
    const rows = (data ?? []) as { id: number; name: string }[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

async function syncModels(): Promise<number> {
  console.log(`Syncing models for ${MAJOR_MAKE_NAMES.length} major makes...`);

  // Resolve names → ids from nhtsa_makes at runtime.
  const allMakes = await pageAllMakes();
  const idByName = new Map<string, number>();
  for (const m of allMakes) idByName.set(m.name.toUpperCase(), m.id);

  const allRows: { id: number; make_id: number; name: string }[] = [];

  for (const name of MAJOR_MAKE_NAMES) {
    const makeId = idByName.get(name);
    if (!makeId) {
      process.stdout.write(`  ${name}(NO_ID) `);
      continue;
    }
    const json = await fetchJson<{
      Results: { Model_ID: number; Model_Name: string }[];
    }>(`${NHTSA_BASE}/GetModelsForMakeId/${makeId}?format=json`);

    if (json?.Results?.length) {
      for (const r of json.Results) {
        allRows.push({ id: r.Model_ID, make_id: makeId, name: r.Model_Name });
      }
    }
    // Rate-limit: 100ms between calls
    await new Promise((r) => setTimeout(r, 100));
    process.stdout.write(`  ${name}(${json?.Results?.length ?? 0}) `);
  }
  console.log();

  const count = await upsertBatch("nhtsa_models", allRows, "id");
  console.log(`  Synced ${count} models`);
  return count;
}

// ── Step 3: Sync WMI records ──────────────────────────────────────────────────
// WMI = first 3 chars of VIN; lib/vin-decoder's last-resort stage looks it up
// to return at least the make. Candidates are (a) every WMI in our active
// inventory — that is what decodes actually see — plus (b) the WMIs vPIC lists
// for a set of common brands. Each is resolved with DecodeWMI, which returns
// the real Make ("CHEVROLET", not "GENERAL MOTORS LLC"); brand-name lookups
// alone miss GM/Lexus/Acura/Infiniti, which vPIC files under the parent.
const COMMON_MANUFACTURERS = [
  "Toyota", "Honda", "Ford", "Chevrolet", "Nissan", "BMW", "Mercedes-Benz",
  "Audi", "Volkswagen", "Hyundai", "Kia", "Subaru", "Mazda", "Lexus",
  "Chrysler", "Dodge", "Jeep", "Ram", "GMC", "Cadillac", "Buick",
  "Acura", "Infiniti", "Mitsubishi", "Volvo", "Porsche", "Jaguar",
  "Land Rover", "Mini", "Tesla", "Rivian", "Genesis", "Lincoln",
];

const WMI_RE = /^[A-HJ-NPR-Z0-9]{3}$/;

async function inventoryWmis(): Promise<Set<string>> {
  const out = new Set<string>();
  let last: string | null = null;
  // Keyset-paged: PostgREST clamps any single read to 1,000 rows.
  for (;;) {
    let q = admin.from("dealer_vehicles").select("id, vin").eq("status", "active").order("id").limit(1000);
    if (last) q = q.gt("id", last);
    const { data, error } = await q;
    if (error) throw new Error(`dealer_vehicles read: ${error.message}`);
    for (const r of data ?? []) {
      const w = String(r.vin ?? "").trim().toUpperCase().slice(0, 3);
      if (WMI_RE.test(w)) out.add(w);
    }
    if (!data || data.length < 1000) break;
    last = data[data.length - 1].id as string;
  }
  return out;
}

async function makeIdByName(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from("nhtsa_makes").select("id, name").order("id").range(from, from + 999);
    if (error) throw new Error(`nhtsa_makes read: ${error.message}`);
    for (const m of data ?? []) {
      const k = String(m.name ?? "").trim().toUpperCase();
      if (k && !out.has(k)) out.set(k, m.id as number);
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function syncWmi(): Promise<number> {
  const candidates = await inventoryWmis();
  console.log(`  ${candidates.size} WMIs in active inventory`);

  console.log(`Collecting WMIs for ${COMMON_MANUFACTURERS.length} brands...`);
  for (const mfr of COMMON_MANUFACTURERS) {
    const json = await fetchJson<{ Results: { WMI: string }[] }>(
      `${NHTSA_BASE}/GetWMIsForManufacturer/${encodeURIComponent(mfr)}?format=json`
    );
    for (const r of json?.Results ?? []) {
      const w = String(r.WMI ?? "").trim().toUpperCase();
      if (WMI_RE.test(w)) candidates.add(w);
    }
    await new Promise((r) => setTimeout(r, 80));
  }

  const makes = await makeIdByName();
  console.log(`Resolving ${candidates.size} WMIs via DecodeWMI...`);
  const rows: { wmi: string; make_id: number | null; manufacturer_name: string; country: string | null }[] = [];
  let unresolved = 0;
  for (const wmi of Array.from(candidates).sort()) {
    const json = await fetchJson<{ Results: { Make?: string; ManufacturerName?: string }[] }>(
      `${NHTSA_BASE}/DecodeWMI/${wmi}?format=json`
    );
    const r = json?.Results?.[0];
    const make = String(r?.Make ?? "").trim();
    const mfrName = String(r?.ManufacturerName ?? "").trim();
    if (!make && !mfrName) { unresolved++; continue; }
    rows.push({
      wmi,
      make_id: make ? makes.get(make.toUpperCase()) ?? null : null,
      // The decoder shows this when make_id has no match — prefer the Make.
      manufacturer_name: make || mfrName,
      country: null,
    });
    await new Promise((res) => setTimeout(res, 60));
  }
  console.log(`  ${rows.length} resolved, ${unresolved} unknown to vPIC`);

  const count = await upsertBatch("nhtsa_wmi", rows, "wmi");
  console.log(`  Synced ${count} WMI records`);
  return count;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== NHTSA vPIC Sync ===");
  const startTime = Date.now();
  let totalImported = 0;

  try {
    const makesCount = await syncMakes();
    const modelsCount = await syncModels();
    const wmiCount = await syncWmi();

    totalImported = makesCount + modelsCount + wmiCount;
    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nDone. ${totalImported} total records in ${elapsedSec}s`);

    await admin.from("nhtsa_sync_log").insert({
      status: "success",
      records_imported: totalImported,
      source_url: NHTSA_BASE,
      notes: `makes=${makesCount} models=${modelsCount} wmi=${wmiCount} elapsed=${elapsedSec}s`,
    });
  } catch (err) {
    console.error("Sync failed:", err);
    await admin.from("nhtsa_sync_log").insert({
      status: "failed",
      records_imported: totalImported,
      source_url: NHTSA_BASE,
      notes: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

main();
