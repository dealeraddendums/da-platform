#!/usr/bin/env node
/**
 * reconcile-addendum-active.mjs — one-time cleanup (task "A").
 *
 * Supabase addendum_data accumulated STALE/DUP/CORRUPT rows because the ETL
 * (addendumData.ts) is incremental-by-_ID + INSERT-only: when Aurora DELETES a
 * superseded option (Aurora removes rows; ACTIVE='no' is unused), Supabase never
 * drops it. Aurora is the clean source of truth. This reconciles, per ACTIVE
 * dealer_vehicle that has Supabase addendum_data, by REPLACING the Supabase rows
 * with Aurora's current set for that (dealer, VIN). Scope: status='active' only
 * (the vehicles the widget serves).
 *
 * RUN ON THE ETL BOX (Aurora + Supabase):
 *   cd /var/www/da-legacy-etl && node reconcile-addendum-active.mjs --dry-run   # preview
 *   cd /var/www/da-legacy-etl && node reconcile-addendum-active.mjs             # apply
 */
import { config } from "dotenv";
import { existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";
for (const p of ["/var/www/da-legacy-etl/.env", ".env"]) if (existsSync(p)) { config({ path: p }); break; }
const pick = (...n) => { for (const x of n) if (process.env[x]) return process.env[x]; };
const DRY = process.argv.includes("--dry-run");
const toTs = (v) => { if (!v) return null; const d = new Date(v); return isNaN(+d) ? null : d.toISOString(); };
const norm = (rows) => rows.map((r) => `${(r.item_name ?? "").trim()}|${r.item_price ?? ""}`).sort().join("~");

async function main() {
  console.log(`\n=== reconcile-addendum-active ${DRY ? "(DRY RUN)" : "(LIVE)"} ===`);
  const pool = await mysql.createPool({ host: pick("AURORA_HOST"), user: pick("AURORA_USER"), password: pick("AURORA_PASSWORD"), database: pick("AURORA_DATABASE") || "dealeraddendums", port: Number(pick("AURORA_PORT") || 3306), connectionLimit: 3 });
  const sb = createClient(pick("SUPABASE_URL"), pick("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

  // dealer text-id → UUID (for inserts)
  const dealerUuid = new Map();
  for (let f = 0; ; f += 1000) { const { data } = await sb.from("dealers").select("dealer_id, id").range(f, f + 999); if (!data?.length) break; for (const d of data) dealerUuid.set(d.dealer_id, d.id); if (data.length < 1000) break; }

  // Iterate all dealers (the loop skips those with no active vehicles). Avoids a
  // 5.6M-row preload just to find which dealers have addendum_data.
  const dealerCodes = new Set(dealerUuid.keys());
  console.log(`dealers to scan: ${dealerCodes.size}`);

  const stats = { dealers: 0, vehiclesActive: 0, vehiclesReconciled: 0, rowsDeleted: 0, rowsInserted: 0, insertSkipped: 0, dealersNoUuid: 0 };
  const samples = [];

  // Batched writes: buffer delete-vehicle-ids + insert-rows, flush in chunks.
  // Delete BEFORE insert so a replaced vehicle ends with exactly Aurora's set.
  const pendingDel = new Set();
  let pendingIns = [];
  async function flush() {
    if (pendingDel.size) {
      const ids = [...pendingDel];
      for (let i = 0; i < ids.length; i += 200) {
        const { error } = await sb.from("addendum_data").delete().in("vehicle_id", ids.slice(i, i + 200));
        if (error) console.error(`  delete batch err: ${error.message}`);
      }
      pendingDel.clear();
    }
    if (pendingIns.length) {
      for (let i = 0; i < pendingIns.length; i += 500) {
        const chunk = pendingIns.slice(i, i + 500);
        const { error } = await sb.from("addendum_data").insert(chunk);
        if (error) {
          // A batch fails wholesale if any legacy_id already exists (partial
          // unique index). Fall back row-by-row to isolate/skip the conflict.
          for (const row of chunk) {
            const { error: e } = await sb.from("addendum_data").insert(row);
            if (e) stats.insertSkipped++;
          }
        }
      }
      pendingIns = [];
    }
  }

  for (const code of dealerCodes) {
    stats.dealers++;
    const uuid = dealerUuid.get(code);
    // active vehicles for this dealer (vin -> id)
    const vinToId = new Map();
    for (let f = 0; ; f += 1000) { const { data } = await sb.from("dealer_vehicles").select("id, vin").eq("dealer_id", code).eq("status", "active").range(f, f + 999); if (!data?.length) break; for (const v of data) if (v.vin) vinToId.set(v.vin.toUpperCase(), v.id); if (data.length < 1000) break; }
    if (!vinToId.size) continue;
    stats.vehiclesActive += vinToId.size;
    const vins = [...vinToId.keys()];

    // Aurora current rows for these vins (grouped by vin)
    const aurByVin = new Map();
    for (let i = 0; i < vins.length; i += 500) {
      const slice = vins.slice(i, i + 500);
      const [rows] = await pool.query(`SELECT _ID, VEHICLE_ID, ITEM_NAME, ITEM_DESCRIPTION, ITEM_PRICE, ACTIVE, SEPARATOR_ABOVE, SEPARATOR_BELOW, SEPARATOR_SPACES, ORDER_BY, EDITABLE, VIN_NUMBER, OR_OR_AD, CREATION_DATE, created_at, updated_at FROM addendum_data WHERE DEALER_ID=? AND VIN_NUMBER IN (${slice.map(() => "?").join(",")})`, [code, ...slice]);
      for (const r of rows) { const k = (r.VIN_NUMBER ?? "").toUpperCase(); if (!aurByVin.has(k)) aurByVin.set(k, []); aurByVin.get(k).push(r); }
    }

    // Supabase rows for these vehicle ids (grouped by vehicle_id)
    const ids = [...vinToId.values()];
    const supaByVeh = new Map();
    for (let i = 0; i < ids.length; i += 300) {
      const slice = ids.slice(i, i + 300);
      const { data } = await sb.from("addendum_data").select("vehicle_id, item_name, item_price").in("vehicle_id", slice);
      for (const r of data ?? []) { if (!supaByVeh.has(r.vehicle_id)) supaByVeh.set(r.vehicle_id, []); supaByVeh.get(r.vehicle_id).push(r); }
    }

    for (const [vin, vehId] of vinToId) {
      const aur = aurByVin.get(vin) ?? [];
      const supa = supaByVeh.get(vehId) ?? [];
      if (!aur.length && !supa.length) continue; // no options either side
      // compare normalized sets
      const aurNorm = norm(aur.map((r) => ({ item_name: r.ITEM_NAME, item_price: r.ITEM_PRICE })));
      const supaNorm = norm(supa);
      if (aurNorm === supaNorm) continue; // already correct
      stats.vehiclesReconciled++;
      stats.rowsDeleted += supa.length;
      stats.rowsInserted += aur.length;
      if (samples.length < 8) samples.push(`${vin} (${code}): supa[${supa.length}] -> aurora[${aur.length}]`);
      if (!DRY) {
        if (!uuid) { stats.dealersNoUuid++; continue; }
        if (supa.length) pendingDel.add(vehId);
        for (const r of aur) pendingIns.push({ dealer_id: uuid, legacy_dealer_id: code, legacy_id: r._ID, legacy_vehicle_id: r.VEHICLE_ID ?? null, vehicle_id: vehId, item_name: r.ITEM_NAME ?? "(unknown)", item_description: r.ITEM_DESCRIPTION ?? null, item_price: r.ITEM_PRICE ?? null, active: r.ACTIVE ?? "1", separator_above: r.SEPARATOR_ABOVE === "1" ? 1 : 0, separator_below: r.SEPARATOR_BELOW === "1" ? 1 : 0, separator_spaces: r.SEPARATOR_SPACES ?? 2, order_by: r.ORDER_BY ?? 0, editable: r.EDITABLE ?? 1, vin_number: vin, or_or_ad: r.OR_OR_AD ? parseInt(r.OR_OR_AD, 10) : 1, document_type: "addendum", created_at: toTs(r.created_at) ?? toTs(r.CREATION_DATE) ?? new Date().toISOString(), updated_at: toTs(r.updated_at) ?? new Date().toISOString() });
        if (pendingIns.length >= 2000 || pendingDel.size >= 400) await flush();
      }
    }
    if (stats.dealers % 200 === 0) console.log(`  …${stats.dealers}/${dealerCodes.size} dealers, ${stats.vehiclesReconciled} vehicles to reconcile so far`);
  }
  if (!DRY) await flush();
  await pool.end();
  console.log(`\n--- Summary ---`);
  console.log(JSON.stringify(stats, null, 1));
  console.log("samples:", samples);
  if (DRY) console.log("DRY RUN — no writes.");
}
main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
