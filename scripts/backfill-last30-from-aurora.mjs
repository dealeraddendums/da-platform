#!/usr/bin/env node
/**
 * backfill-last30-from-aurora.mjs — restore dealers.last30 for LEGACY dealers
 * from Aurora dealer_dim.LAST30.
 *
 * WHY: last30 for legacy dealers reflects LEGACY-platform print activity and
 * lives in Aurora dealer_dim.LAST30 (imported once by scripts/import-dealers.ts).
 * The sync-hubspot-computed cron recomputes last30 from print_history (NEW-platform
 * prints only) and — once it started paginating (498740e, 2026-06-25) — overwrote
 * every legacy dealer's last30 with 0, breaking DA Pulse (which gates on last30
 * for ALL dealers). The cron is now scoped to new-platform dealers; this restores
 * the legacy values from Aurora. Match key: dealer_dim.DEALER_ID = dealers.inventory_dealer_id.
 *
 * RUN ON THE ETL BOX (only host with both Aurora + Supabase):
 *   ssh -i ~/ssh/da-legacy-etl.pem ubuntu@ec2-34-205-73-152.compute-1.amazonaws.com
 *   cd /var/www/da-legacy-etl && node backfill-last30-from-aurora.mjs --dry-run   # preview
 *   cd /var/www/da-legacy-etl && node backfill-last30-from-aurora.mjs             # apply
 *
 * Idempotent (sets last30 to Aurora's value; re-run is a no-op once synced).
 */
import { config } from "dotenv";
import { existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";

const DRY = process.argv.includes("--dry-run");
for (const p of [process.env.DOTENV_PATH, "/var/www/da-legacy-etl/.env", ".env"].filter(Boolean)) {
  if (existsSync(p)) { config({ path: p }); console.log(`(env from ${p})`); break; }
}
const pick = (...n) => { for (const x of n) if (process.env[x]) return process.env[x]; };

async function main() {
  console.log(`\n=== backfill-last30-from-aurora ${DRY ? "(DRY RUN)" : "(LIVE)"} ===`);

  // 1. Aurora dealer_dim.LAST30
  const conn = await mysql.createConnection({
    host: pick("AURORA_HOST"), user: pick("AURORA_USER"), password: pick("AURORA_PASSWORD"),
    database: pick("AURORA_DATABASE") || "dealeraddendums", port: Number(pick("AURORA_PORT") || 3306),
  });
  const [aur] = await conn.execute("SELECT DEALER_ID, LAST30 FROM dealer_dim WHERE DEALER_ID IS NOT NULL");
  await conn.end();
  const auroraLast30 = new Map();
  for (const r of aur) auroraLast30.set(String(r.DEALER_ID).trim(), r.LAST30 == null ? 0 : Number(r.LAST30));
  console.log(`Aurora dealer_dim rows: ${aur.length}`);

  // 2. Supabase dealers
  const db = createClient(pick("SUPABASE_URL"), pick("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  const dealers = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("dealers")
      .select("id, dealer_id, inventory_dealer_id, migration_status, last30").order("id").range(from, from + 999);
    if (error) throw new Error("dealers read: " + error.message);
    dealers.push(...data); if (data.length < 1000) break;
  }
  console.log(`Supabase dealers: ${dealers.length}`);

  // 3. Compute updates for LEGACY dealers only
  const updates = [];
  let legacy = 0, skippedNew = 0, noAurora = 0, unchanged = 0;
  for (const d of dealers) {
    const isNew = d.migration_status === "migrated" || (d.dealer_id || "").startsWith("ss_");
    if (isNew) { skippedNew++; continue; }
    legacy++;
    const inv = (d.inventory_dealer_id || "").trim();
    if (!auroraLast30.has(inv)) { noAurora++; continue; }
    const target = auroraLast30.get(inv);
    if ((d.last30 ?? 0) !== target) updates.push({ id: d.id, dealer_id: d.dealer_id, from: d.last30, to: target });
    else unchanged++;
  }
  console.log(`legacy=${legacy} skippedNew=${skippedNew} matchedAurora=${legacy - noAurora} noAuroraMatch=${noAurora} unchanged=${unchanged} toUpdate=${updates.length}`);
  console.log("sample:", updates.slice(0, 12).map((u) => `${u.dealer_id}: ${u.from}->${u.to}`).join(", "));

  // 4. Apply
  if (!DRY) {
    let done = 0;
    for (const u of updates) {
      const { error } = await db.from("dealers").update({ last30: u.to }).eq("id", u.id);
      if (error) console.error("  update err", u.dealer_id, error.message); else done++;
    }
    console.log(`updated ${done}/${updates.length}`);
  } else {
    console.log("DRY RUN — no writes.");
  }

  // 5. Post distribution
  const { count: gt0 } = await db.from("dealers").select("id", { count: "exact", head: true }).gt("last30", 0);
  const { count: gte4 } = await db.from("dealers").select("id", { count: "exact", head: true }).gte("last30", 4);
  const { count: total } = await db.from("dealers").select("id", { count: "exact", head: true });
  console.log(`post-distribution: last30>0=${gt0}  last30>=4=${gte4}  total=${total}`);
}
main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
