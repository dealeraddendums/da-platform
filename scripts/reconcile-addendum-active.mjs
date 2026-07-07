#!/usr/bin/env node
/**
 * reconcile-addendum-active.mjs — reconcile Supabase addendum_data against Aurora's
 * current rows for ACTIVE vehicles (task A one-time + task B recurring).
 *
 * WHY: Supabase addendum_data is missing/stale/dup for ~45% of active vehicles —
 * the ETL (addendumData.ts) is incremental-by-_ID + INSERT-only, so it never
 * backfills nor removes rows Aurora deleted. Aurora is the clean source. Per
 * active vehicle, REPLACE the Supabase rows with Aurora's current set.
 *
 * CONCURRENT worker pool (fast) + synchronous progress file (observable, since
 * Node block-buffers stdout to a file). Progress: tail /tmp/reconcile-progress.log
 *
 * RUN ON THE ETL BOX:
 *   cd /var/www/da-legacy-etl && node reconcile-addendum-active.mjs --dry-run
 *   cd /var/www/da-legacy-etl && node reconcile-addendum-active.mjs
 */
import { config } from "dotenv";
import { existsSync, appendFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";
for (const p of ["/var/www/da-legacy-etl/.env", ".env"]) if (existsSync(p)) { config({ path: p }); break; }
const pick = (...n) => { for (const x of n) if (process.env[x]) return process.env[x]; };
const DRY = process.argv.includes("--dry-run");
const CONC = 8;
const PROGRESS = "/tmp/reconcile-progress.log";
const toTs = (v) => { if (!v) return null; const d = new Date(v); return isNaN(+d) ? null : d.toISOString(); };
const norm = (rows) => rows.map((r) => `${(r.n ?? "").trim()}|${r.p ?? ""}`).sort().join("~");
const log = (m) => { try { appendFileSync(PROGRESS, m + "\n"); } catch { /* */ } };

async function main() {
  log(`\n=== START ${new Date().toISOString()} dry=${DRY} ===`);
  const pool = await mysql.createPool({ host: pick("AURORA_HOST"), user: pick("AURORA_USER"), password: pick("AURORA_PASSWORD"), database: pick("AURORA_DATABASE") || "dealeraddendums", port: Number(pick("AURORA_PORT") || 3306), connectionLimit: CONC + 2 });
  const sb = createClient(pick("SUPABASE_URL"), pick("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

  const dealerUuid = new Map();
  for (let f = 0; ; f += 1000) { const { data } = await sb.from("dealers").select("dealer_id, id").range(f, f + 999); if (!data?.length) break; for (const d of data) dealerUuid.set(d.dealer_id, d.id); if (data.length < 1000) break; }
  const codes = [...dealerUuid.keys()];
  log(`dealers to scan: ${codes.length}`);

  const stats = { dealers: 0, vehiclesActive: 0, vehiclesReconciled: 0, rowsDeleted: 0, rowsInserted: 0, insertSkipped: 0, errors: 0 };
  const samples = [];

  async function processDealer(code) {
    const uuid = dealerUuid.get(code);
    const vinToId = new Map();
    for (let f = 0; ; f += 1000) { const { data } = await sb.from("dealer_vehicles").select("id, vin").eq("dealer_id", code).eq("status", "active").range(f, f + 999); if (!data?.length) break; for (const v of data) if (v.vin) vinToId.set(v.vin.toUpperCase(), v.id); if (data.length < 1000) break; }
    if (!vinToId.size) return;
    stats.vehiclesActive += vinToId.size;
    const vins = [...vinToId.keys()];

    const aurByVin = new Map();
    for (let i = 0; i < vins.length; i += 500) {
      const slice = vins.slice(i, i + 500);
      const [rows] = await pool.query(`SELECT _ID, VEHICLE_ID, ITEM_NAME, ITEM_DESCRIPTION, ITEM_PRICE, ACTIVE, SEPARATOR_ABOVE, SEPARATOR_BELOW, SEPARATOR_SPACES, ORDER_BY, EDITABLE, VIN_NUMBER, OR_OR_AD, CREATION_DATE, created_at, updated_at FROM addendum_data WHERE DEALER_ID=? AND VIN_NUMBER IN (${slice.map(() => "?").join(",")})`, [code, ...slice]);
      for (const r of rows) { const k = (r.VIN_NUMBER ?? "").toUpperCase(); if (!aurByVin.has(k)) aurByVin.set(k, []); aurByVin.get(k).push(r); }
    }
    const ids = [...vinToId.values()];
    const supaByVeh = new Map();
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await sb.from("addendum_data").select("vehicle_id, item_name, item_price").in("vehicle_id", ids.slice(i, i + 200));
      for (const r of data ?? []) { if (!supaByVeh.has(r.vehicle_id)) supaByVeh.set(r.vehicle_id, []); supaByVeh.get(r.vehicle_id).push(r); }
    }

    const delIds = [];
    let insRows = [];
    for (const [vin, vehId] of vinToId) {
      const aur = aurByVin.get(vin) ?? [];
      const supa = supaByVeh.get(vehId) ?? [];
      if (!aur.length && !supa.length) continue;
      if (norm(aur.map((r) => ({ n: r.ITEM_NAME, p: r.ITEM_PRICE }))) === norm(supa.map((r) => ({ n: r.item_name, p: r.item_price })))) continue;
      stats.vehiclesReconciled++; stats.rowsDeleted += supa.length; stats.rowsInserted += aur.length;
      if (samples.length < 8) samples.push(`${vin} (${code}): supa[${supa.length}]->aurora[${aur.length}]`);
      if (!DRY && uuid) {
        if (supa.length) delIds.push(vehId);
        for (const r of aur) insRows.push({ dealer_id: uuid, legacy_dealer_id: code, legacy_id: r._ID, legacy_vehicle_id: r.VEHICLE_ID ?? null, vehicle_id: vehId, item_name: r.ITEM_NAME ?? "(unknown)", item_description: r.ITEM_DESCRIPTION ?? null, item_price: r.ITEM_PRICE ?? null, active: r.ACTIVE ?? "1", separator_above: r.SEPARATOR_ABOVE === "1" ? 1 : 0, separator_below: r.SEPARATOR_BELOW === "1" ? 1 : 0, separator_spaces: r.SEPARATOR_SPACES ?? 2, order_by: r.ORDER_BY ?? 0, editable: r.EDITABLE ?? 1, vin_number: vin, or_or_ad: r.OR_OR_AD ? parseInt(r.OR_OR_AD, 10) : 1, document_type: "addendum", created_at: toTs(r.created_at) ?? toTs(r.CREATION_DATE) ?? new Date().toISOString(), updated_at: toTs(r.updated_at) ?? new Date().toISOString() });
      }
    }
    if (!DRY) {
      for (let i = 0; i < delIds.length; i += 150) { const { error } = await sb.from("addendum_data").delete().in("vehicle_id", delIds.slice(i, i + 150)); if (error) log(`  del err ${code}: ${error.message}`); }
      for (let i = 0; i < insRows.length; i += 500) {
        const chunk = insRows.slice(i, i + 500);
        const { error } = await sb.from("addendum_data").insert(chunk);
        if (error) { for (const row of chunk) { const { error: e } = await sb.from("addendum_data").insert(row); if (e) stats.insertSkipped++; } }
      }
    }
  }

  let idx = 0;
  async function worker() {
    while (idx < codes.length) {
      const code = codes[idx++];
      try { await processDealer(code); } catch (e) { stats.errors++; log(`ERR ${code}: ${e.message}`); }
      stats.dealers++;
      if (stats.dealers % 25 === 0) log(`${new Date().toISOString().slice(11, 19)} ${stats.dealers}/${codes.length} | recon=${stats.vehiclesReconciled} del=${stats.rowsDeleted} ins=${stats.rowsInserted} skip=${stats.insertSkipped} err=${stats.errors}`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  await pool.end();
  log(`=== DONE ${new Date().toISOString()} ${JSON.stringify(stats)} ===`);
  console.log("Summary:", JSON.stringify(stats, null, 1));
  console.log("samples:", samples);
}
main().catch((e) => { log(`FATAL ${e.message}`); console.error("FATAL", e.message); process.exit(1); });
