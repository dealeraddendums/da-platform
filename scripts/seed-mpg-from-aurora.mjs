#!/usr/bin/env node
/**
 * seed-mpg-from-aurora.mjs — ONE-TIME seed of dealer_vehicles.cmpg/hmpg from
 * the legacy Aurora `dealer_inventory` table (CMPG = city, HMPG = highway).
 *
 * The MPG editor fields + infosheet widget shipped, but 0 of ~1.5M
 * dealer_vehicles rows carried MPG (the feed/ETL never mapped them). This is a
 * one-time backfill. Ongoing freshness is Allan's via etl2 / DA Pulse.
 *
 * Spec: docs/mpg-seed.md.  Run on the da-platform EC2 (the local
 * SUPABASE_SERVICE_ROLE_KEY is truncated):
 *
 *   ssh -i ~/ssh/DA_Platform_2026.pem ubuntu@<da-platform-host>
 *   cd /var/www/da-platform
 *   node scripts/seed-mpg-from-aurora.mjs            # AUDIT + DRY-RUN (no writes)
 *   node scripts/seed-mpg-from-aurora.mjs --apply    # apply Supabase writes
 *
 * GUARDRAILS
 *  - Aurora is READ-ONLY. This script only ever SELECTs from Aurora.
 *  - Integers only: a value is taken only if it's a clean positive integer in
 *    [5,150] mpg. CMPG and HMPG validated INDEPENDENTLY (seed the good one,
 *    leave the junk one null). Junk = non-numeric / empty / N/A / 0 / negative
 *    / decimal / out-of-range.
 *  - Fill nulls only — never overwrite a manually-entered value. The UPDATE
 *    itself carries .is('cmpg', null) / .is('hmpg', null) guards, so re-running
 *    = 0 changes (idempotent).
 *  - Match key: dealer_vehicles.(dealer_id, UPPER(vin)) == Aurora
 *    dealer_inventory.(DEALER_ID, UPPER(VIN_NUMBER)). Skip no-match.
 */

import { config } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";

// Load env from the first dotenv file that exists, so this runs on whichever
// box can reach Aurora (DA Platform, DA Legacy ETL, or DA Pulse). Override with
// DOTENV_PATH=/path/to/.env if needed.
const ENV_CANDIDATES = [
  process.env.DOTENV_PATH,
  "/var/www/da-platform/.env.production",
  "/var/www/da-legacy-etl/.env",
  "./.env.production",
  "./.env",
].filter(Boolean);
for (const p of ENV_CANDIDATES) { if (existsSync(p)) { config({ path: p }); console.log(`(env loaded from ${p})`); break; } }

// Tolerate the different env-var names used across boxes.
const pick = (...names) => { for (const n of names) { if (process.env[n]) return process.env[n]; } return undefined; };
const AURORA_HOST = pick("AURORA_HOST", "DB_HOST", "MYSQL_HOST", "LEGACY_DB_HOST");
const AURORA_USER = pick("AURORA_USER", "DB_USER", "MYSQL_USER", "LEGACY_DB_USER");
const AURORA_PASS = pick("AURORA_PASSWORD", "DB_PASSWORD", "MYSQL_PASSWORD", "LEGACY_DB_PASSWORD", "AURORA_PASS");
const AURORA_DB   = pick("AURORA_DATABASE", "DB_NAME", "DB_DATABASE", "MYSQL_DATABASE", "LEGACY_DB_NAME") || "dealeraddendums";
const AURORA_PORT = pick("AURORA_PORT", "DB_PORT", "MYSQL_PORT") || "3306";

const APPLY = process.argv.includes("--apply");
// Two-box handoff: when Aurora isn't reachable from the box that has the Supabase
// service key, read the Aurora candidate rows from a TSV exported elsewhere.
// TSV columns (tab-separated, no header): DEALER_ID, VIN_NUMBER, CMPG, HMPG (\N = null).
const tsvArg = process.argv.find((a) => a.startsWith("--from-tsv"));
const FROM_TSV = tsvArg ? (tsvArg.includes("=") ? tsvArg.split("=")[1] : process.argv[process.argv.indexOf(tsvArg) + 1]) : null;
const MODE = `${APPLY ? "APPLY" : "AUDIT + DRY-RUN (no writes)"}${FROM_TSV ? `  [candidates from TSV: ${FROM_TSV}]` : ""}`;

const MPG_MIN = 5;
const MPG_MAX = 150;
const VIN_BATCH = 300;   // dealer_vehicles .in('vin', …) page size
const ID_BATCH = 200;    // .in('id', …) update page size

// ── clients ──────────────────────────────────────────────────────────────────
const SUPA_URL = pick("NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL");
const SUPA_KEY = pick("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY", "SUPABASE_KEY");
if (!SUPA_URL || !SUPA_KEY || SUPA_KEY.length < 100) {
  console.error("Supabase env missing/truncated — must point at the DA Platform project with a full service-role key."); process.exit(1);
}
if (!FROM_TSV && (!AURORA_HOST || !AURORA_USER || !AURORA_PASS)) {
  console.error("Aurora env missing (need host/user/password) — run on a box with live Aurora access, or pass --from-tsv."); process.exit(1);
}
console.log(`Supabase: ${SUPA_URL}`);
if (!FROM_TSV) console.log(`Aurora:   ${AURORA_USER}@${AURORA_HOST}:${AURORA_PORT}/${AURORA_DB}`);
console.log("");
const sb = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });

const pool = FROM_TSV ? null : mysql.createPool({
  host: AURORA_HOST,
  user: AURORA_USER,
  password: AURORA_PASS,
  database: AURORA_DB,
  port: parseInt(AURORA_PORT, 10),
  waitForConnections: true, connectionLimit: 3, connectTimeout: 30_000, enableKeepAlive: true,
});

// ── helpers ────────────────────────────────────────────────────────────────--
/** Clean positive integer in [MPG_MIN, MPG_MAX], else null. */
function cleanMpg(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!/^[1-9][0-9]*$/.test(s)) return null;       // positive int, no sign/decimal/leading-zero
  const n = parseInt(s, 10);
  if (n < MPG_MIN || n > MPG_MAX) return null;
  return String(n);
}

async function q(sql, params = []) { const [rows] = await pool.query(sql, params); return rows; }

function pct(n, d) { return d ? ((100 * n) / d).toFixed(1) + "%" : "0%"; }

// ──────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== MPG seed from Aurora dealer_inventory — ${MODE} ===\n`);

  let rows;
  if (FROM_TSV) {
    // Candidates exported elsewhere (box with Aurora access). Columns:
    // DEALER_ID \t VIN_NUMBER \t CMPG \t HMPG  (\N = null). Header line tolerated.
    const text = readFileSync(FROM_TSV, "utf8");
    rows = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      const f = line.split("\t");
      if (f.length < 4) continue;
      if (f[0] === "DEALER_ID") continue; // skip header if present
      const un = (v) => (v === "\\N" || v === "NULL" || v === undefined ? null : v);
      rows.push({ DEALER_ID: un(f[0]), VIN_NUMBER: un(f[1]), CMPG: un(f[2]), HMPG: un(f[3]) });
    }
    console.log(`Candidate rows loaded from TSV: ${rows.length}\n`);
  } else {
    // 0. Confirm the source columns exist.
    const cols = await q("SHOW COLUMNS FROM dealer_inventory");
    const colNames = new Set(cols.map((c) => c.Field.toUpperCase()));
    for (const needed of ["DEALER_ID", "VIN_NUMBER", "CMPG", "HMPG"]) {
      if (!colNames.has(needed)) { console.error(`dealer_inventory has no column ${needed}; abort.`); process.exit(1); }
    }
    console.log("Source columns present: DEALER_ID, VIN_NUMBER, CMPG, HMPG\n");

    // 1. Coverage audit (read-only, server-side counts).
    const intRe = "'^[1-9][0-9]*$'";
    const [tot] = await q("SELECT COUNT(*) n FROM dealer_inventory");
    const [cNon] = await q("SELECT COUNT(*) n FROM dealer_inventory WHERE CMPG IS NOT NULL AND TRIM(CMPG) <> ''");
    const [hNon] = await q("SELECT COUNT(*) n FROM dealer_inventory WHERE HMPG IS NOT NULL AND TRIM(HMPG) <> ''");
    const [cInt] = await q(`SELECT COUNT(*) n FROM dealer_inventory WHERE CMPG REGEXP ${intRe} AND CAST(CMPG AS UNSIGNED) BETWEEN ${MPG_MIN} AND ${MPG_MAX}`);
    const [hInt] = await q(`SELECT COUNT(*) n FROM dealer_inventory WHERE HMPG REGEXP ${intRe} AND CAST(HMPG AS UNSIGNED) BETWEEN ${MPG_MIN} AND ${MPG_MAX}`);
    console.log(`dealer_inventory rows ........... ${tot.n}`);
    console.log(`  CMPG non-empty ................ ${cNon.n}  → clean int [${MPG_MIN}-${MPG_MAX}]: ${cInt.n}  (junk: ${cNon.n - cInt.n})`);
    console.log(`  HMPG non-empty ................ ${hNon.n}  → clean int [${MPG_MIN}-${MPG_MAX}]: ${hInt.n}  (junk: ${hNon.n - hInt.n})\n`);

    // 2. Pull seed candidates: any row with at least one clean-int CMPG or HMPG.
    rows = await q(
      `SELECT _ID, DEALER_ID, VIN_NUMBER, CMPG, HMPG
         FROM dealer_inventory
        WHERE (CMPG REGEXP ${intRe} AND CAST(CMPG AS UNSIGNED) BETWEEN ${MPG_MIN} AND ${MPG_MAX})
           OR (HMPG REGEXP ${intRe} AND CAST(HMPG AS UNSIGNED) BETWEEN ${MPG_MIN} AND ${MPG_MAX})
        ORDER BY _ID ASC`
    );
    console.log(`Aurora candidate rows (≥1 valid MPG): ${rows.length}`);
  }

  // Build map keyed dealerId|VIN_UPPER → {cmpg, hmpg} (most recent _ID wins).
  const map = new Map();
  const vinSet = new Set();
  let skipNoVin = 0, skipNoDealer = 0;
  for (const r of rows) {
    const dealer = r.DEALER_ID == null ? "" : String(r.DEALER_ID).trim();
    const vinUp = r.VIN_NUMBER == null ? "" : String(r.VIN_NUMBER).trim().toUpperCase();
    if (!vinUp) { skipNoVin++; continue; }
    if (!dealer) { skipNoDealer++; continue; }
    const cmpg = cleanMpg(r.CMPG);
    const hmpg = cleanMpg(r.HMPG);
    if (!cmpg && !hmpg) continue;
    map.set(`${dealer}|${vinUp}`, { cmpg, hmpg });
    vinSet.add(vinUp);
  }
  console.log(`Unique (dealer_id, VIN) keys ...... ${map.size}   (skipped: no-VIN ${skipNoVin}, no-dealer ${skipNoDealer})`);
  console.log(`Unique VINs to look up ............ ${vinSet.size}\n`);

  // 3. Match to Supabase dealer_vehicles by (dealer_id, UPPER(vin)); compute fills.
  const vins = [...vinSet];
  let scanned = 0, matched = 0, vinCaseLower = 0;
  let fillC = 0, fillH = 0, fillBoth = 0, alreadyC = 0, alreadyH = 0, junkSkipC = 0, junkSkipH = 0;
  const samplesFill = [], samplesManual = [];
  // group updates by exact payload so we can do one .update().in('id', …) per group
  const groups = new Map(); // key → { payload, guard, ids: [] }

  function addGroup(key, payload, guard, id) {
    let g = groups.get(key);
    if (!g) { g = { payload, guard, ids: [] }; groups.set(key, g); }
    g.ids.push(id);
  }

  for (let i = 0; i < vins.length; i += VIN_BATCH) {
    const batch = vins.slice(i, i + VIN_BATCH);
    const { data, error } = await sb
      .from("dealer_vehicles")
      .select("id, dealer_id, vin, cmpg, hmpg")
      .in("vin", batch);
    if (error) throw error;
    for (const row of data ?? []) {
      scanned++;
      const vinUp = (row.vin ?? "").toUpperCase();
      if (row.vin && row.vin !== vinUp) vinCaseLower++;
      const hit = map.get(`${row.dealer_id}|${vinUp}`);
      if (!hit) continue;
      matched++;

      const curC = row.cmpg == null || String(row.cmpg).trim() === "";
      const curH = row.hmpg == null || String(row.hmpg).trim() === "";
      const setC = curC && hit.cmpg != null;
      const setH = curH && hit.hmpg != null;
      // junk-skip accounting: Supabase null but Aurora value was junk (no clean int)
      if (curC && hit.cmpg == null) junkSkipC++;
      if (curH && hit.hmpg == null) junkSkipH++;
      if (!curC && hit.cmpg != null) { alreadyC++; if (samplesManual.length < 5) samplesManual.push({ id: row.id, dealer: row.dealer_id, vin: vinUp, existing_cmpg: row.cmpg, aurora_cmpg: hit.cmpg }); }
      if (!curH && hit.hmpg != null) alreadyH++;

      if (setC && setH) {
        fillBoth++; fillC++; fillH++;
        addGroup(`both|${hit.cmpg}|${hit.hmpg}`, { cmpg: hit.cmpg, hmpg: hit.hmpg }, "both", row.id);
      } else if (setC) {
        fillC++;
        addGroup(`c|${hit.cmpg}`, { cmpg: hit.cmpg }, "c", row.id);
      } else if (setH) {
        fillH++;
        addGroup(`h|${hit.hmpg}`, { hmpg: hit.hmpg }, "h", row.id);
      }
      if ((setC || setH) && samplesFill.length < 12) {
        samplesFill.push({ dealer: row.dealer_id, vin: vinUp, set_cmpg: setC ? hit.cmpg : "—", set_hmpg: setH ? hit.hmpg : "—", aurora: `${hit.cmpg ?? "junk"}/${hit.hmpg ?? "junk"}` });
      }
    }
  }

  const rowsToTouch = [...groups.values()].reduce((a, g) => a + g.ids.length, 0);

  console.log("── Match + dry-run ─────────────────────────────────────────");
  console.log(`dealer_vehicles rows scanned (VIN-matched batches): ${scanned}`);
  console.log(`  matched to an Aurora MPG key .... ${matched}  (${pct(matched, map.size)} of keys)`);
  console.log(`  unmatched keys (no dealer_vehicles row) ~ ${map.size - matched}`);
  if (vinCaseLower) console.log(`  ⚠ ${vinCaseLower} dealer_vehicles rows had non-uppercase VINs (still matched via UPPER()).`);
  console.log("");
  console.log(`Rows that WOULD be filled ......... ${rowsToTouch}`);
  console.log(`  cmpg set .................. ${fillC}   (both-fields: ${fillBoth})`);
  console.log(`  hmpg set .................. ${fillH}`);
  console.log(`  skipped — Aurora junk (Supabase null, no clean int): cmpg ${junkSkipC}, hmpg ${junkSkipH}`);
  console.log(`  skipped — already populated (manual/prior): cmpg ${alreadyC}, hmpg ${alreadyH}`);
  console.log(`  distinct update groups (by value) ${groups.size}\n`);

  if (samplesFill.length) {
    console.log("Sample fills:");
    for (const s of samplesFill) console.log(`  ${s.dealer}  ${s.vin}  → cmpg=${s.set_cmpg} hmpg=${s.set_hmpg}  (aurora ${s.aurora})`);
    console.log("");
  }
  if (samplesManual.length) {
    console.log("Sample SKIPPED (already populated — left untouched):");
    for (const s of samplesManual) console.log(`  ${s.dealer}  ${s.vin}  existing cmpg=${s.existing_cmpg} (aurora ${s.aurora_cmpg})`);
    console.log("");
  }

  if (!APPLY) {
    console.log(`>>> DRY-RUN complete. Nothing written. Re-run with --apply to seed ${rowsToTouch} rows.\n`);
    if (pool) await pool.end();
    return;
  }

  // 4. APPLY — grouped, DB-level null-guarded updates (idempotent).
  console.log("── APPLY ───────────────────────────────────────────────────");
  let applied = 0;
  for (const g of groups.values()) {
    for (let i = 0; i < g.ids.length; i += ID_BATCH) {
      const ids = g.ids.slice(i, i + ID_BATCH);
      let upd = sb.from("dealer_vehicles").update(g.payload).in("id", ids);
      if (g.guard === "both") upd = upd.is("cmpg", null).is("hmpg", null);
      else if (g.guard === "c") upd = upd.is("cmpg", null);
      else if (g.guard === "h") upd = upd.is("hmpg", null);
      const { data, error } = await upd.select("id");
      if (error) { console.error(`  update error (${JSON.stringify(g.payload)}):`, error.message); continue; }
      applied += data?.length ?? 0;
    }
    process.stdout.write(".");
  }
  console.log(`\n>>> APPLY complete. Rows updated: ${applied} (expected ${rowsToTouch}).\n`);
  if (pool) await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
