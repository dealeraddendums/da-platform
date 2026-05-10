/**
 * harvest-trims-from-vins.ts — One-shot backfill of nhtsa_trims from existing
 * dealer_vehicles VINs. Runs the shared harvestTrimsFromVins library against
 * every VIN currently in dealer_vehicles, deduplicates by VIN squish before
 * calling NHTSA, and upserts decoded Trim/Series values into nhtsa_trims.
 *
 * Run on EC2: cd /var/www/da-platform && npx tsx scripts/harvest-trims-from-vins.ts
 *
 * The same logic also runs daily under /api/cron/harvest-vin-trims; this
 * script is for the initial pass over the existing ~500K vehicle inventory.
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

import { harvestTrimsFromVins } from "../lib/nhtsa-trim-harvester";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PAGE_SIZE = 5000;

async function loadAllVins(): Promise<string[]> {
  const all: string[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from("dealer_vehicles")
      .select("vin")
      .not("vin", "is", null)
      .neq("vin", "")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { vin: string | null }[];
    if (rows.length === 0) break;
    for (const r of rows) {
      if (r.vin && r.vin.trim().length >= 11) all.push(r.vin);
    }
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
    if (from % 50_000 === 0) console.log(`  loaded ${all.length} VINs so far…`);
  }
  return all;
}

async function main() {
  console.log("=== NHTSA Trim Harvest from dealer_vehicles VINs ===");
  const startCounts = await sb.from("nhtsa_trims").select("*", { count: "exact", head: true });
  console.log(`Starting nhtsa_trims count: ${startCounts.count ?? "?"}`);

  console.log("Loading VINs from dealer_vehicles…");
  const vins = await loadAllVins();
  console.log(`Loaded ${vins.length} VINs.`);

  let lastLogAt = Date.now();
  const stats = await harvestTrimsFromVins(sb, vins, (s) => {
    if (Date.now() - lastLogAt > 10_000) {
      lastLogAt = Date.now();
      console.log(`  decoded ${s.decoded}/${s.uniqueSquishes} unique VINs · ${s.trimRowsUpserted} trim rows · ${Math.round(s.elapsedMs / 1000)}s elapsed`);
    }
  });

  const endCounts = await sb.from("nhtsa_trims").select("*", { count: "exact", head: true });
  console.log("\n=== Summary ===");
  console.log(`  total VINs:           ${stats.totalVins}`);
  console.log(`  unique squishes:      ${stats.uniqueSquishes}`);
  console.log(`  decoded by NHTSA:     ${stats.decoded}`);
  console.log(`  decode errors:        ${stats.decodeErrors}`);
  console.log(`  skipped (no trim):    ${stats.skippedNoTrim}`);
  console.log(`  skipped (no make):    ${stats.skippedNoMake}`);
  console.log(`  skipped (no model):   ${stats.skippedNoModel}`);
  console.log(`  trim rows upserted:   ${stats.trimRowsUpserted}`);
  console.log(`  elapsed:              ${Math.round(stats.elapsedMs / 1000)}s`);
  console.log(`  nhtsa_trims now:      ${endCounts.count ?? "?"} total rows`);
}

main().catch(e => { console.error(e); process.exit(1); });
