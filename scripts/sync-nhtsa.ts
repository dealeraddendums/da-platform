/**
 * sync-nhtsa.ts — Download and import NHTSA vPIC data into Supabase.
 * Run: npx tsx scripts/sync-nhtsa.ts
 * Cron: every 14 days  (0 4 1,15 * *  on EC2)
 *
 * Imports:
 *   1. All makes  (~12k records, one API call)
 *   2. Models for top common makes
 *   3. WMI records from known manufacturers
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
  const BATCH = 500;
  let total = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error, data } = await admin
      .from(table)
      .upsert(batch, { onConflict: conflictCol })
      .select("*");
    if (error) {
      console.warn(`  upsert error on ${table}:`, error.message);
    } else {
      total += data?.length ?? 0;
    }
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
// WMI = first 3 chars of VIN. Map common manufacturer names to their WMIs.
const COMMON_MANUFACTURERS = [
  "Toyota", "Honda", "Ford", "Chevrolet", "Nissan", "BMW", "Mercedes-Benz",
  "Audi", "Volkswagen", "Hyundai", "Kia", "Subaru", "Mazda", "Lexus",
  "Chrysler", "Dodge", "Jeep", "Ram", "GMC", "Cadillac", "Buick",
  "Acura", "Infiniti", "Mitsubishi", "Volvo", "Porsche", "Jaguar",
  "Land Rover", "Mini", "Tesla", "Rivian", "Genesis", "Lincoln",
];

async function syncWmi(): Promise<number> {
  console.log(`Syncing WMI for ${COMMON_MANUFACTURERS.length} manufacturers...`);
  const allRows: { wmi: string; manufacturer_name: string; country: string | null }[] = [];

  for (const mfr of COMMON_MANUFACTURERS) {
    const json = await fetchJson<{
      Results: {
        WMI: string;
        ManufacturerName: string;
        Country: string;
        Make?: string;
      }[];
    }>(`${NHTSA_BASE}/GetWMIsForManufacturer/${encodeURIComponent(mfr)}?format=json`);

    if (json?.Results?.length) {
      for (const r of json.Results) {
        if (r.WMI) {
          allRows.push({
            wmi: r.WMI,
            manufacturer_name: r.ManufacturerName ?? mfr,
            country: r.Country ?? null,
          });
        }
      }
    }
    await new Promise((r) => setTimeout(r, 80));
    process.stdout.write(`  ${mfr}(${json?.Results?.length ?? 0}) `);
  }
  console.log();

  const count = await upsertBatch("nhtsa_wmi", allRows, "wmi");
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
