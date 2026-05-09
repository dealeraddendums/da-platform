/**
 * seed-nhtsa-trims.ts — Best-effort seed of nhtsa_trims using NHTSA's
 * Canadian Vehicle Specifications endpoint, the only publicly-documented
 * bulk-by-model trim source. Coverage is partial: NHTSA does not publish
 * a bulk per-model trim list via vPIC, so models with no Canadian listing
 * (or US-only trim names) won't be returned. The Add Product modal already
 * falls through to an "Enter Trim" free-text input for any model not in
 * nhtsa_trims, so partial coverage is acceptable.
 *
 * Run on EC2: cd /var/www/da-platform && npx tsx scripts/seed-nhtsa-trims.ts
 *
 * Strategy:
 *   1. Load all (model_id, model_name, make_id, make_name) joined rows.
 *   2. For each (make, model) and year in YEARS, call:
 *      https://vpic.nhtsa.dot.gov/api/vehicles/GetCanadianVehicleSpecifications/?Year={y}&Make={m}&Model={mod}&format=json
 *   3. Parse Results[].Specs[] for {Name: "Trim Name"} entries.
 *   4. Upsert (model_id, name) with a deterministic int hash as id so re-runs
 *      are idempotent without a schema change.
 *   5. Throttle to ~120ms between requests to be polite to NHTSA.
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

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const YEARS = [2025, 2026];
const REQUEST_DELAY_MS = 120;
const PROGRESS_EVERY = 50;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// FNV-1a 32-bit hash, clamped to positive int4 range.
function trimId(modelId: number, name: string): number {
  const s = `${modelId}:${name.toLowerCase().trim()}`;
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Reserve top bit so we stay in positive int4.
  return h & 0x7fffffff;
}

interface ModelRow {
  id: number;
  name: string;
  make_id: number;
}

interface MakeRow {
  id: number;
  name: string;
}

interface CanadianSpec {
  Name?: string;
  Value?: string | null;
}
interface CanadianResult {
  Specs?: CanadianSpec[];
}
interface CanadianResponse {
  Count?: number;
  Results?: CanadianResult[];
}

async function fetchTrims(makeName: string, modelName: string, year: number): Promise<string[]> {
  const url = `https://vpic.nhtsa.dot.gov/api/vehicles/GetCanadianVehicleSpecifications/?Year=${year}&Make=${encodeURIComponent(makeName)}&Model=${encodeURIComponent(modelName)}&format=json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return [];
    const json = (await res.json()) as CanadianResponse;
    const found = new Set<string>();
    for (const r of json.Results ?? []) {
      for (const spec of r.Specs ?? []) {
        const n = (spec.Name ?? "").toLowerCase();
        const v = (spec.Value ?? "").trim();
        if (!v) continue;
        if (n.includes("trim")) found.add(v);
      }
    }
    return Array.from(found);
  } catch {
    return [];
  }
}

async function main() {
  console.log("=== NHTSA Trim Seeder (best-effort, Canadian Specs) ===");

  const { data: makes } = await sb.from("nhtsa_makes").select("id, name").returns<MakeRow[]>();
  const { data: models } = await sb.from("nhtsa_models").select("id, name, make_id").returns<ModelRow[]>();
  if (!makes?.length || !models?.length) {
    console.error("Refusing to run: nhtsa_makes or nhtsa_models is empty. Run sync-nhtsa.ts first.");
    process.exit(1);
  }
  const makeName = new Map<number, string>(makes.map(m => [m.id, m.name]));

  console.log(`Iterating ${models.length} models × ${YEARS.length} years...`);

  let processed = 0;
  let totalInserted = 0;
  let modelsWithTrims = 0;
  let lastLoggedAt = Date.now();

  for (const model of models) {
    const make = makeName.get(model.make_id);
    if (!make) { processed++; continue; }

    const seen = new Set<string>();
    for (const year of YEARS) {
      const trims = await fetchTrims(make, model.name, year);
      for (const t of trims) seen.add(t);
      await sleep(REQUEST_DELAY_MS);
    }

    if (seen.size > 0) {
      modelsWithTrims++;
      const rows = Array.from(seen).map(name => ({
        id: trimId(model.id, name),
        model_id: model.id,
        name,
      }));
      const { error } = await sb.from("nhtsa_trims").upsert(rows, { onConflict: "id" });
      if (error) {
        console.error(`  ${make} ${model.name}: upsert error ${error.message}`);
      } else {
        totalInserted += rows.length;
      }
    }

    processed++;
    if (processed % PROGRESS_EVERY === 0) {
      const elapsed = Math.round((Date.now() - lastLoggedAt) / 1000);
      lastLoggedAt = Date.now();
      console.log(`  ${processed}/${models.length} processed · ${modelsWithTrims} models with trims · ${totalInserted} rows inserted · last batch ${elapsed}s`);
    }
  }

  const { count } = await sb.from("nhtsa_trims").select("*", { count: "exact", head: true });
  console.log(`Done. ${processed} models processed, ${modelsWithTrims} returned trim data, ${totalInserted} new rows. nhtsa_trims now has ${count ?? "?"} total rows.`);
}

main().catch(e => { console.error(e); process.exit(1); });
