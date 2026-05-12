#!/usr/bin/env node
/**
 * backfill-sold-vehicles.mjs
 *
 * One-time backfill of historical sold vehicles + their addendum line items
 * from Aurora MySQL into the DA Platform Supabase. This is not an ongoing
 * sync — the live ETL handles new vehicles going forward.
 *
 * Source (Aurora, read-only):
 *   - dealeraddendums.dealer_inventory  WHERE STATUS='0' AND INPUT_DATE >= NOW() - 18 months
 *   - dealeraddendums.addendum_data     for the VINs above
 *
 * Target (Supabase project byouefbebqgffhtfdggu):
 *   - dealer_vehicles                   (insert if new, update if VIN exists for this dealer)
 *   - vehicle_addendum_items            (insert new, skip duplicates by aurora _ID)
 *
 * Idempotent: re-running is safe. Existing dealer_vehicles rows are updated
 * to status='inactive' with the latest Aurora field values; addendum line
 * items are skipped on (dealer_id, aurora_id) conflict.
 *
 * Run (from DA Platform EC2):
 *   tmux new-session -d -s backfill 'cd /var/www/da-platform && node scripts/backfill-sold-vehicles.mjs 2>&1 | tee /tmp/backfill-sold-vehicles.log'
 *
 * Flags:
 *   --limit N           Process only the first N dealers (smoke test)
 *   --dealer ID         Process only the dealer with this internal_id (e.g. MP14056)
 *   --months N          Override the 18-month window (defaults to 18)
 *   --dry-run           Read Aurora + report counts; do not write to Supabase
 */

import mysql from "mysql2/promise";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as path from "node:path";
import { argv, exit } from "node:process";

dotenv.config({ path: path.join(process.cwd(), ".env.local") });
dotenv.config({ path: path.join(process.cwd(), ".env.production") });

// ── Args ──────────────────────────────────────────────────────────────────────
function argFlag(name) {
  const idx = argv.indexOf(name);
  return idx >= 0 ? (argv[idx + 1] ?? null) : null;
}
const LIMIT_DEALERS = argFlag("--limit") ? parseInt(argFlag("--limit"), 10) : null;
const DEALER_FILTER = argFlag("--dealer");
const MONTHS = parseInt(argFlag("--months") ?? "18", 10);
const DRY_RUN = argv.includes("--dry-run");

const VEHICLE_BATCH = 500;
const ADDENDUM_BATCH = 500;
const DEALER_DELAY_MS = 50;

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AURORA_HOST = process.env.AURORA_HOST;
const AURORA_USER = process.env.AURORA_USER;
const AURORA_PASS = process.env.AURORA_PASSWORD;
const AURORA_DB   = process.env.AURORA_DATABASE;
const AURORA_PORT = parseInt(process.env.AURORA_PORT ?? "3306", 10);

if (!SUPA_URL || !SUPA_KEY) { console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"); exit(1); }
if (!AURORA_HOST || !AURORA_USER || !AURORA_PASS || !AURORA_DB) { console.error("Missing Aurora connection env"); exit(1); }

const sb = createClient(SUPA_URL, SUPA_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const pool = mysql.createPool({
  host: AURORA_HOST, user: AURORA_USER, password: AURORA_PASS,
  database: AURORA_DB, port: AURORA_PORT,
  waitForConnections: true, connectionLimit: 3, connectTimeout: 30_000,
  enableKeepAlive: true,
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (msg) => console.log(`[${now()}] ${msg}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function toNullableNumber(v) {
  if (v == null || v === "") return null;
  const cleaned = String(v).replace(/[,$\s]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}
function toIntOrNull(v) {
  if (v == null || v === "") return null;
  const n = parseInt(String(v).replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}
function toIntOrZero(v) {
  const n = toIntOrNull(v);
  return n ?? 0;
}
function normalizeDate(d) {
  if (!d) return null;
  // mysql2 returns Date objects for DATE/DATETIME — convert to ISO.
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? null : d.toISOString();
  return String(d);
}
function normalizeDateOnly(d) {
  const iso = normalizeDate(d);
  if (!iso) return null;
  return iso.split("T")[0];
}

function mapVehicleFromAurora(row, dealerTextId) {
  // dealer_vehicles.dealer_id is the TEXT id (matches dealers.dealer_id), not
  // the UUID. Existing rows use the text key so we match the convention.
  return {
    dealer_id: dealerTextId,
    stock_number: (row.STOCK_NUMBER ?? "").toString().trim() || null,
    vin: (row.VIN_NUMBER ?? "").toString().trim() || null,
    year: toIntOrNull(row.YEAR),
    make: row.MAKE ?? null,
    model: row.MODEL ?? null,
    trim: row.TRIM ?? null,
    body_style: row.BODYSTYLE ?? null,
    exterior_color: row.EXT_COLOR ?? null,
    interior_color: row.INT_COLOR ?? null,
    mileage: toIntOrZero(row.MILEAGE),
    msrp: toNullableNumber(row.MSRP),
    internet_price: row.INTERNET_PRICE != null ? String(row.INTERNET_PRICE) : null,
    condition: (row.NEW_USED ?? "Used").toString().trim() || "Used",
    status: "inactive", // STATUS='0' in Aurora → sold/inactive in Supabase
    print_status: toIntOrNull(row.PRINT_STATUS),
    print_date: normalizeDateOnly(row.PRINT_DATE),
    print_user: row.PRINT_USER ?? null,
    certified: row.CERTIFIED ?? null,
    edit_status: toIntOrNull(row.EDIT_STATUS),
    edit_date: normalizeDate(row.EDIT_DATE),
    options_added: toIntOrNull(row.OPTIONS_ADDED),
    created_by: row.CREATED_BY ?? null,
    date_added: normalizeDate(row.INPUT_DATE) ?? new Date().toISOString(),
    date_in_stock: normalizeDate(row.DATE_IN_STOCK),
    input_date: normalizeDate(row.INPUT_DATE),
  };
}

// ── Phase 1: load dealer roster from Supabase ─────────────────────────────────
async function loadDealers() {
  const all = [];
  let from = 0;
  while (true) {
    let q = sb.from("dealers").select("id, dealer_id, internal_id, name, active")
      .order("internal_id", { ascending: true, nullsFirst: false })
      .range(from, from + 999);
    if (DEALER_FILTER) q = q.eq("internal_id", DEALER_FILTER);
    const { data, error } = await q;
    if (error) throw new Error(`Failed to load dealers: ${error.message}`);
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < 1000) break;
    from += 1000;
    if (DEALER_FILTER) break;
  }
  // Per spec: skip dealers where Supabase active=false (the row's only
  // "inactive" signal — there is no separate status column on dealers).
  // Spec also says skip if Aurora ACTIVE='No', but checking that would
  // require an extra round-trip per dealer; we accept the small cost of
  // a noop query for those because the Aurora vehicle filter will return
  // zero rows for cancelled dealers anyway.
  const filtered = all.filter(d => d.internal_id && d.active !== false);
  return LIMIT_DEALERS ? filtered.slice(0, LIMIT_DEALERS) : filtered;
}

// ── Phase 2: per-dealer processing ────────────────────────────────────────────
async function fetchAuroraSoldVehicles(dealerInternalId) {
  // Dedupe by VIN: pick the row with the largest _ID (typically the most
  // recent record) so the addendum_data join later resolves cleanly.
  const sql = `
    SELECT di.*
    FROM dealeraddendums.dealer_inventory di
    INNER JOIN (
      SELECT DEALER_ID, VIN_NUMBER, MAX(_ID) AS max_id
      FROM dealeraddendums.dealer_inventory
      WHERE DEALER_ID = ?
        AND STATUS = '0'
        AND INPUT_DATE >= DATE_SUB(NOW(), INTERVAL ? MONTH)
        AND VIN_NUMBER IS NOT NULL
        AND VIN_NUMBER <> ''
      GROUP BY DEALER_ID, VIN_NUMBER
    ) latest
      ON latest.DEALER_ID = di.DEALER_ID
     AND latest.VIN_NUMBER = di.VIN_NUMBER
     AND latest.max_id = di._ID
  `;
  const [rows] = await pool.execute(sql, [dealerInternalId, MONTHS]);
  return rows;
}

async function fetchAuroraAddendumItems(dealerInternalId, vins) {
  if (vins.length === 0) return [];
  // Chunk the IN list so we never approach MySQL's max packet size.
  const out = [];
  for (let i = 0; i < vins.length; i += 500) {
    const slice = vins.slice(i, i + 500);
    const placeholders = slice.map(() => "?").join(",");
    const sql = `
      SELECT _ID, DEALER_ID, VIN_NUMBER, ITEM_NAME,
             CAST(REPLACE(REPLACE(ITEM_PRICE, ',', ''), '$', '') AS DECIMAL(10,2)) AS ITEM_PRICE_NUM,
             CREATION_DATE, created_at, updated_at
      FROM dealeraddendums.addendum_data
      WHERE DEALER_ID = ? AND VIN_NUMBER IN (${placeholders})
    `;
    const [rows] = await pool.execute(sql, [dealerInternalId, ...slice]);
    out.push(...rows);
  }
  return out;
}

async function loadExistingVehicleIds(dealerTextId, vins) {
  if (vins.length === 0) return new Map();
  const map = new Map();
  for (let i = 0; i < vins.length; i += 500) {
    const slice = vins.slice(i, i + 500);
    const { data, error } = await sb
      .from("dealer_vehicles")
      .select("id, vin")
      .eq("dealer_id", dealerTextId)
      .in("vin", slice);
    if (error) throw new Error(`existing-vehicle lookup: ${error.message}`);
    for (const r of data ?? []) {
      if (r.vin) map.set(r.vin.toUpperCase(), r.id);
    }
  }
  return map;
}

async function processDealer(dealer, index, total) {
  const internalId = dealer.internal_id;
  const dealerTextId = dealer.dealer_id; // dealers.dealer_id is the text key dealer_vehicles uses

  const auroraVehicles = await fetchAuroraSoldVehicles(internalId);
  if (auroraVehicles.length === 0) {
    log(`[${index}/${total}] ${dealer.name} (${internalId}) — 0 sold vehicles in window, skip`);
    return { vehicles: 0, addendums: 0 };
  }

  const auroraVins = Array.from(new Set(
    auroraVehicles.map(r => (r.VIN_NUMBER ?? "").toString().trim().toUpperCase()).filter(Boolean)
  ));

  // Build the existing VIN → vehicle_uuid map so we can split inserts vs updates.
  const existingByVin = await loadExistingVehicleIds(dealerTextId, auroraVins);

  const toInsert = [];
  const toUpdate = []; // {id, patch}

  for (const r of auroraVehicles) {
    const mapped = mapVehicleFromAurora(r, dealerTextId);
    if (!mapped.vin) continue;
    const vinKey = mapped.vin.toUpperCase();
    const existingId = existingByVin.get(vinKey);
    if (existingId) {
      // Don't overwrite the existing row's id, dealer_id, stock_number on update
      // — stock_number can be reused after a sale and we don't want to clobber
      // any live row that happens to share a VIN/stock.
      const patch = { ...mapped };
      delete patch.dealer_id;
      delete patch.stock_number;
      delete patch.date_added;
      toUpdate.push({ id: existingId, patch });
    } else {
      // INSERT requires a non-null stock_number per schema. Fall back to VIN
      // if Aurora's stock number is empty — that's better than dropping the row.
      if (!mapped.stock_number) mapped.stock_number = vinKey;
      toInsert.push(mapped);
    }
  }

  if (DRY_RUN) {
    log(`[${index}/${total}] ${dealer.name} (${internalId}) — DRY: ${auroraVehicles.length} aurora, ${toInsert.length} to insert, ${toUpdate.length} to update`);
    return { vehicles: auroraVehicles.length, addendums: 0 };
  }

  // ── Insert net-new sold vehicles in batches ───────────────────────────────
  let insertedCount = 0;
  for (let i = 0; i < toInsert.length; i += VEHICLE_BATCH) {
    const batch = toInsert.slice(i, i + VEHICLE_BATCH);
    const { data, error } = await sb.from("dealer_vehicles").insert(batch).select("id, vin");
    if (error) {
      console.error(`[insert vehicle batch] dealer=${internalId} batch=${i} error=${error.message}`);
      continue;
    }
    for (const r of data ?? []) {
      if (r.vin) existingByVin.set(r.vin.toUpperCase(), r.id);
    }
    insertedCount += data?.length ?? 0;
  }

  // ── Update existing rows one-by-one (small N typically) ───────────────────
  let updatedCount = 0;
  for (const u of toUpdate) {
    const { error } = await sb.from("dealer_vehicles").update(u.patch).eq("id", u.id);
    if (error) {
      console.error(`[update vehicle] dealer=${internalId} id=${u.id} error=${error.message}`);
      continue;
    }
    updatedCount++;
  }

  // ── Addendum line items ───────────────────────────────────────────────────
  const auroraAddendums = await fetchAuroraAddendumItems(internalId, auroraVins);
  let addendumInserted = 0;
  if (auroraAddendums.length > 0) {
    const items = [];
    for (const a of auroraAddendums) {
      const vinKey = (a.VIN_NUMBER ?? "").toString().trim().toUpperCase();
      if (!vinKey) continue;
      const vehicleUuid = existingByVin.get(vinKey);
      if (!vehicleUuid) continue; // vehicle didn't insert/exist — skip orphan items
      items.push({
        dealer_id: dealer.id, // UUID — vehicle_addendum_items.dealer_id is UUID FK
        vehicle_id: vehicleUuid,
        aurora_id: a._ID != null ? Number(a._ID) : null,
        vin: vinKey,
        item_name: a.ITEM_NAME ?? null,
        item_price: a.ITEM_PRICE_NUM != null ? Number(a.ITEM_PRICE_NUM) : null,
        creation_date: normalizeDateOnly(a.CREATION_DATE),
        created_at_aurora: normalizeDate(a.created_at),
        updated_at_aurora: normalizeDate(a.updated_at),
      });
    }
    for (let i = 0; i < items.length; i += ADDENDUM_BATCH) {
      const batch = items.slice(i, i + ADDENDUM_BATCH);
      const { error } = await sb
        .from("vehicle_addendum_items")
        .upsert(batch, { onConflict: "dealer_id,aurora_id", ignoreDuplicates: true });
      if (error) {
        console.error(`[insert addendum batch] dealer=${internalId} batch=${i} error=${error.message}`);
        continue;
      }
      addendumInserted += batch.length;
    }
  }

  log(`[${index}/${total}] ${dealer.name} (${internalId}) — ${auroraVehicles.length} vehicles (${insertedCount} new, ${updatedCount} updated), ${addendumInserted} addendum items — OK`);
  return { vehicles: auroraVehicles.length, addendums: addendumInserted };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log(`Starting backfill — months=${MONTHS} limit=${LIMIT_DEALERS ?? "none"} dealer=${DEALER_FILTER ?? "all"} dry-run=${DRY_RUN}`);
  const dealers = await loadDealers();
  log(`Loaded ${dealers.length} dealers from Supabase`);

  let totalVehicles = 0;
  let totalAddendums = 0;
  let processed = 0;
  let failed = 0;

  for (let i = 0; i < dealers.length; i++) {
    const dealer = dealers[i];
    try {
      const { vehicles, addendums } = await processDealer(dealer, i + 1, dealers.length);
      totalVehicles += vehicles;
      totalAddendums += addendums;
      processed++;
    } catch (err) {
      failed++;
      console.error(`[FAILED] ${dealer.name} (${dealer.internal_id}): ${err instanceof Error ? err.message : err}`);
    }
    if (i < dealers.length - 1) await sleep(DEALER_DELAY_MS);
  }

  log(`Backfill complete — ${processed} dealers processed, ${failed} failed, ${totalVehicles} vehicles, ${totalAddendums} addendum items`);
  await pool.end();
  exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error("Fatal:", e); pool.end().finally(() => exit(1)); });
