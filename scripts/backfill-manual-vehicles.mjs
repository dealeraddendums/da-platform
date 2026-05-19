#!/usr/bin/env node
/**
 * backfill-manual-vehicles.mjs
 *
 * One-time backfill of manually-imported vehicles from Aurora MySQL into the
 * DA Platform Supabase. Manual imports are vehicles the dealer added by hand
 * via Excel, the legacy web app, or the VIN API — they're not picked up by
 * the automatic inventory-feed ETL because the feeds only cover dealers on
 * a live data supplier (CDK / vAuto / etc).
 *
 * Source (Aurora, read-only):
 *   - dealeraddendums.dealer_inventory
 *       WHERE CREATED_BY IN ('EXCEL', 'APP', 'VIN API')
 *         AND INPUT_DATE >= NOW() - 18 months
 *         AND DEALER_ID NOT IN (excluded test dealers)
 *   - dealeraddendums.addendum_data for the VINs above
 *
 * Target (Supabase project byouefbebqgffhtfdggu):
 *   - dealer_vehicles            (insert new, skip existing — ON CONFLICT DO NOTHING)
 *   - addendum_data              (insert new, skip duplicates by legacy_id)
 *
 * Differences from backfill-sold-vehicles.mjs:
 *   - Pulls both STATUS=0 (sold) and STATUS=1 (active) — manual imports
 *     can be either at the time of sync.
 *   - Filters by CREATED_BY rather than STATUS.
 *   - Never overwrites — existing rows are left alone (DO NOTHING).
 *   - Skips dealers whose name contains "test" or "allan" so test accounts
 *     don't pollute production. Matches the Legacy ETL exclusion filter.
 *
 * Idempotent: re-run safe. ON CONFLICT DO NOTHING on both tables.
 *
 * Run (from DA Platform EC2):
 *   tmux new-session -d -s manual-backfill \
 *     'cd /var/www/da-platform && node scripts/backfill-manual-vehicles.mjs 2>&1 | tee /tmp/backfill-manual-vehicles.log'
 *
 * Flags:
 *   --limit N           Process only the first N dealers (smoke test)
 *   --dealer ID         Process only the dealer with this dealer_id (e.g. MP14056)
 *   --months N          Override the 18-month window (defaults to 18)
 *   --dry-run           Read Aurora + report counts; do not write to Supabase
 */

import mysql from "mysql2/promise";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as path from "node:path";
import { argv, exit } from "node:process";

for (const name of [".env.local", ".env.production", ".env"]) {
  dotenv.config({ path: path.join(process.cwd(), name) });
}

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
const EXCLUSION_RE = /(test|allan)/i;

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
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
function clampInt(v, lo, hi) {
  if (v == null) return null;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
function clampYear(v)    { return v == null ? null : (v < 1900 || v > 2100 ? null : v); }
function clampMileage(v) { return v == null ? 0    : clampInt(v, 0, 2_000_000); }
function clampMsrp(v)    { return v == null ? null : (v < 0 || v > 9_999_999.99 ? null : v); }
function normalizeDate(d) {
  if (!d) return null;
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? null : d.toISOString();
  return String(d);
}
function normalizeDateOnly(d) {
  const iso = normalizeDate(d);
  if (!iso) return null;
  return iso.split("T")[0];
}

function mapVehicleFromAurora(row, dealerTextId) {
  // Map STATUS='1' (active) → status='active', '0' (sold) → 'inactive'.
  // Differs from the sold-only backfill which hard-coded 'inactive'.
  const isActive = (row.STATUS ?? "").toString() === "1";
  return {
    dealer_id: dealerTextId,
    stock_number: (row.STOCK_NUMBER ?? "").toString().trim() || null,
    vin: (row.VIN_NUMBER ?? "").toString().trim() || null,
    year: clampYear(toIntOrNull(row.YEAR)),
    make: row.MAKE ?? null,
    model: row.MODEL ?? null,
    trim: row.TRIM ?? null,
    body_style: row.BODYSTYLE ?? null,
    exterior_color: row.EXT_COLOR ?? null,
    interior_color: row.INT_COLOR ?? null,
    mileage: clampMileage(toIntOrZero(row.MILEAGE)),
    msrp: clampMsrp(toNullableNumber(row.MSRP)),
    internet_price: row.INTERNET_PRICE != null ? String(row.INTERNET_PRICE) : null,
    condition: (row.NEW_USED ?? "Used").toString().trim() || "Used",
    status: isActive ? "active" : "inactive",
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
    if (DEALER_FILTER) q = q.or(`dealer_id.eq.${DEALER_FILTER},internal_id.eq.${DEALER_FILTER}`);
    const { data, error } = await q;
    if (error) throw new Error(`Failed to load dealers: ${error.message}`);
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < 1000) break;
    from += 1000;
    if (DEALER_FILTER) break;
  }
  // Same filter the Legacy ETL applies — drop test accounts before we even
  // hit Aurora. Logs each exclusion so the run report shows what was skipped.
  const filtered = all.filter(d => {
    if (!d.dealer_id || d.active === false) return false;
    if (EXCLUSION_RE.test(d.name ?? "")) {
      log(`[SKIP] Dealer "${d.name}" — matches exclusion filter`);
      return false;
    }
    return true;
  });
  return LIMIT_DEALERS ? filtered.slice(0, LIMIT_DEALERS) : filtered;
}

// ── Phase 2: per-dealer processing ────────────────────────────────────────────
async function fetchAuroraManualVehicles(auroraDealerId) {
  // Dedupe by VIN: pick the row with the largest _ID (most recent record).
  // Both STATUS=0 and STATUS=1 included — manual imports can be either.
  const sql = `
    SELECT di.*
    FROM dealeraddendums.dealer_inventory di
    INNER JOIN (
      SELECT DEALER_ID, VIN_NUMBER, MAX(_ID) AS max_id
      FROM dealeraddendums.dealer_inventory
      WHERE DEALER_ID = ?
        AND CREATED_BY IN ('EXCEL', 'APP', 'VIN API')
        AND INPUT_DATE >= DATE_SUB(NOW(), INTERVAL ? MONTH)
        AND VIN_NUMBER IS NOT NULL
        AND VIN_NUMBER <> ''
      GROUP BY DEALER_ID, VIN_NUMBER
    ) latest
      ON latest.DEALER_ID = di.DEALER_ID
     AND latest.VIN_NUMBER = di.VIN_NUMBER
     AND latest.max_id = di._ID
  `;
  const [rows] = await pool.execute(sql, [auroraDealerId, MONTHS]);
  return rows;
}

async function fetchAuroraAddendumItems(auroraDealerId, vins) {
  if (vins.length === 0) return [];
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
    const [rows] = await pool.execute(sql, [auroraDealerId, ...slice]);
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

/**
 * Build a stock_number → vin map for everything currently in this dealer's
 * dealer_vehicles. dealer_vehicles UNIQUE is on (dealer_id, stock_number),
 * not (dealer_id, vin) — so we need to detect cases where the Aurora
 * stock_number is already held by a different VIN (recycled stock numbers
 * after a sale) and swap to VIN-as-stock for those rows before insert.
 */
async function loadStockToVinMap(dealerTextId) {
  const map = new Map();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("dealer_vehicles")
      .select("vin, stock_number")
      .eq("dealer_id", dealerTextId)
      .range(from, from + 999);
    if (error) throw new Error(`stock_number lookup: ${error.message}`);
    const rows = data ?? [];
    for (const r of rows) {
      if (r.stock_number) {
        map.set(r.stock_number, (r.vin ?? "").toUpperCase());
      }
    }
    if (rows.length < 1000) break;
  }
  return map;
}

async function processDealer(dealer, index, total) {
  // Aurora dealer_inventory.DEALER_ID matches Supabase dealers.dealer_id
  // (verified 2026-05-11). internal_id is the Unix-timestamp billing ID.
  const auroraDealerId = dealer.dealer_id;
  const dealerTextId = dealer.dealer_id;

  const auroraVehicles = await fetchAuroraManualVehicles(auroraDealerId);
  if (auroraVehicles.length === 0) {
    log(`[${index}/${total}] ${dealer.name} (${auroraDealerId}) — 0 manual vehicles, skip`);
    return { vehicles: 0, addendums: 0 };
  }

  const auroraVins = Array.from(new Set(
    auroraVehicles.map(r => (r.VIN_NUMBER ?? "").toString().trim().toUpperCase()).filter(Boolean)
  ));

  // VIN → vehicle_uuid for already-existing rows. Used both to skip
  // already-present manual vehicles and to map their UUIDs onto incoming
  // addendum line items below.
  const existingByVin = await loadExistingVehicleIds(dealerTextId, auroraVins);
  // dealer_vehicles UNIQUE is (dealer_id, stock_number) — we need this map
  // to spot recycled stock numbers and swap to VIN-as-stock before insert.
  const takenStock = await loadStockToVinMap(dealerTextId);

  // Build insert payload — skip any VIN that already exists (never
  // overwrite manual entries; they may have been edited in the new
  // platform). Then resolve stock_number collisions for net-new rows.
  const toInsert = [];
  let alreadyExisted = 0;
  for (const r of auroraVehicles) {
    const mapped = mapVehicleFromAurora(r, dealerTextId);
    if (!mapped.vin) continue;
    const vinKey = mapped.vin.toUpperCase();
    if (existingByVin.has(vinKey)) { alreadyExisted++; continue; }

    // Stock-number collision handling (matches backfill-sold-vehicles):
    //   1. Aurora has no stock_number → use VIN
    //   2. Aurora's stock_number is held by a DIFFERENT VIN already → use VIN
    //   3. Otherwise keep Aurora's stock_number
    const auroraStock = mapped.stock_number?.toString().trim() ?? "";
    const takenBy = auroraStock ? takenStock.get(auroraStock) : "";
    const stockConflict = takenBy && takenBy !== vinKey;
    if (!auroraStock || stockConflict) {
      mapped.stock_number = vinKey;
    }
    // Reserve in-memory so two Aurora rows in the same batch with the same
    // stock_number don't both pass the conflict check.
    takenStock.set(mapped.stock_number, vinKey);
    toInsert.push(mapped);
  }

  if (DRY_RUN) {
    log(`[${index}/${total}] ${dealer.name} (${auroraDealerId}) — DRY: ${auroraVehicles.length} aurora, ${toInsert.length} to insert, ${alreadyExisted} already exist`);
    return { vehicles: auroraVehicles.length, addendums: 0 };
  }

  // ── Insert net-new manual vehicles in batches ──────────────────────────────
  // We pre-filtered against existing VINs, so a plain insert is correct —
  // the dealer_id+stock_number unique constraint is the only collision risk
  // and we already swapped stock_number → VIN above when it would collide.
  let insertedCount = 0;
  for (let i = 0; i < toInsert.length; i += VEHICLE_BATCH) {
    const batch = toInsert.slice(i, i + VEHICLE_BATCH);
    const { data, error } = await sb.from("dealer_vehicles").insert(batch).select("id, vin");
    if (error) {
      console.error(`[insert vehicle batch] dealer=${auroraDealerId} batch=${i} error=${error.message}`);
      continue;
    }
    for (const r of data ?? []) {
      if (r.vin) existingByVin.set(r.vin.toUpperCase(), r.id);
    }
    insertedCount += data?.length ?? 0;
  }

  // ── Addendum line items ────────────────────────────────────────────────────
  const auroraAddendums = await fetchAuroraAddendumItems(auroraDealerId, auroraVins);
  let addendumInserted = 0;
  if (auroraAddendums.length > 0) {
    const items = [];
    for (const a of auroraAddendums) {
      const vinKey = (a.VIN_NUMBER ?? "").toString().trim().toUpperCase();
      if (!vinKey) continue;
      const vehicleUuid = existingByVin.get(vinKey);
      if (!vehicleUuid) continue; // vehicle didn't insert/exist — skip orphan
      const nowIso = new Date().toISOString();
      items.push({
        dealer_id: dealer.id,
        legacy_dealer_id: auroraDealerId,
        vehicle_id: vehicleUuid,
        legacy_id: a._ID != null ? Number(a._ID) : null,
        vin_number: vinKey,
        item_name: a.ITEM_NAME ?? "(unknown)",
        item_price: a.ITEM_PRICE_NUM != null ? String(a.ITEM_PRICE_NUM) : null,
        document_type: "addendum",
        active: "1",
        or_or_ad: 1,
        order_by: 0,
        separator_spaces: 2,
        editable: 1,
        created_at: normalizeDate(a.created_at) ?? nowIso,
        updated_at: normalizeDate(a.updated_at) ?? nowIso,
      });
    }
    for (let i = 0; i < items.length; i += ADDENDUM_BATCH) {
      const batch = items.slice(i, i + ADDENDUM_BATCH);
      // ON CONFLICT (dealer_id, legacy_id) DO NOTHING — same partial-index
      // limitation as backfill 058: ignoreDuplicates over the
      // legacy_id partial-unique index isn't inferred by PostgREST.
      // Pre-filter against the existing legacy_id set instead.
      const legacyIds = batch.map(b => b.legacy_id).filter(v => v != null);
      const { data: existing } = await sb
        .from("addendum_data")
        .select("legacy_id")
        .in("legacy_id", legacyIds);
      const existingSet = new Set((existing ?? []).map(r => r.legacy_id));
      const fresh = batch.filter(b => !existingSet.has(b.legacy_id));
      if (fresh.length === 0) continue;
      const { error } = await sb.from("addendum_data").insert(fresh);
      if (error) {
        console.error(`[insert addendum batch] dealer=${auroraDealerId} batch=${i} error=${error.message}`);
        continue;
      }
      addendumInserted += fresh.length;
    }
  }

  log(`[${index}/${total}] ${dealer.name} (${auroraDealerId}) — ${auroraVehicles.length} manual vehicles (${insertedCount} new), ${addendumInserted} addendum items — OK`);
  return { vehicles: auroraVehicles.length, addendums: addendumInserted };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log(`Starting manual vehicle backfill — months=${MONTHS} limit=${LIMIT_DEALERS ?? "none"} dealer=${DEALER_FILTER ?? "all"} dry-run=${DRY_RUN}`);
  const dealers = await loadDealers();
  log(`Loaded ${dealers.length} dealers from Supabase (after exclusion filter)`);

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
      console.error(`[FAILED] ${dealer.name} (${dealer.dealer_id}): ${err instanceof Error ? err.message : err}`);
    }
    if (i < dealers.length - 1) await sleep(DEALER_DELAY_MS);
  }

  log(`Manual vehicle backfill complete — ${processed} dealers processed, ${failed} failed, ${totalVehicles} vehicles, ${totalAddendums} addendum items`);
  await pool.end();
  exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error("Fatal:", e); pool.end().finally(() => exit(1)); });
