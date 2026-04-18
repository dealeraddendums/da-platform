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
const MAJOR_MAKE_IDS: Record<number, string> = {
  474: "ACURA", 475: "ALFA ROMEO", 476: "ASTON MARTIN", 478: "AUDI",
  479: "BENTLEY", 482: "BMW", 484: "BUICK", 485: "CADILLAC",
  487: "CHEVROLET", 491: "CHRYSLER", 492: "DODGE", 497: "FERRARI",
  499: "FIAT", 500: "FORD", 503: "GENESIS", 504: "GMC",
  507: "HONDA", 508: "HYUNDAI", 510: "INFINITI", 512: "JAGUAR",
  513: "JEEP", 515: "KIA", 516: "LAMBORGHINI", 521: "LAND ROVER",
  523: "LEXUS", 524: "LINCOLN", 526: "LOTUS", 530: "MASERATI",
  531: "MAZDA", 535: "MERCEDES-BENZ", 538: "MINI", 540: "MITSUBISHI",
  541: "NISSAN", 544: "OLDSMOBILE", 545: "PONTIAC", 548: "PORSCHE",
  549: "RAM", 550: "RIVIAN", 551: "ROLLS-ROYCE", 553: "SUBARU",
  555: "TESLA", 559: "TOYOTA", 562: "VOLKSWAGEN", 563: "VOLVO",
};

async function syncModels(): Promise<number> {
  console.log(`Syncing models for ${Object.keys(MAJOR_MAKE_IDS).length} major makes...`);
  const allRows: { id: number; make_id: number; name: string }[] = [];

  for (const [makeIdStr, makeName] of Object.entries(MAJOR_MAKE_IDS)) {
    const makeId = parseInt(makeIdStr, 10);
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
    process.stdout.write(`  ${makeName}(${json?.Results?.length ?? 0}) `);
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
