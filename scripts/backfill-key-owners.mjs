#!/usr/bin/env node
/**
 * backfill-key-owners.mjs — one-time populate of Supabase `key_owners`, the API-key
 * store consumed by da-api-service's key-gated routes (/search, /getvehicleoptions,
 * /getdealerdefaults). Until this runs, those routes fail closed ("Invalid key.").
 *
 * SOURCE: the legacy API Portal box's LOCAL MySQL — host 127.0.0.1, database `da`,
 *   table `key_owners` (columns: username, user_key, dealer_id, user_email, …).
 *   NOTE: this is the box's local MySQL, NOT the Aurora cluster. Small table (~9 rows).
 * TARGET: Supabase `key_owners` (da-platform migration 120 — apply it FIRST).
 *
 * MAPPING legacy dealer → Supabase dealer_id:
 *   1. PRIMARY  — dealers.inventory_dealer_id == key_owners.dealer_id (case-insensitive)
 *   2. FALLBACK — dealers.name == key_owners.username (EXACT, case-insensitive)
 *   Anything else is left UNMATCHED and logged for manual mapping. We never
 *   fuzzy-guess: a wrong API-key→dealer binding would expose one dealer's data
 *   to another's key. (The source has no dealer-name field, so the fallback is
 *   intentionally an exact username match only.)
 *
 * Idempotent: upsert on user_key. --dry-run writes nothing (run it first).
 *
 * RUN — the source MySQL is only reachable on/through the legacy box, so tunnel it:
 *   ssh -i ~/ssh/DA2025.pem -N -L 3307:127.0.0.1:3306 ubuntu@ec2-52-2-212-135 &
 *   KEYOWNER_DB_HOST=127.0.0.1 KEYOWNER_DB_PORT=3307 \
 *   KEYOWNER_DB_USER=root KEYOWNER_DB_PASSWORD=<legacy-mysql-pass> KEYOWNER_DB_NAME=da \
 *   node scripts/backfill-key-owners.mjs --dry-run     # preview
 *   node scripts/backfill-key-owners.mjs               # apply
 *
 * Supabase creds come from .env.production (NEXT_PUBLIC_SUPABASE_URL + SERVICE_ROLE_KEY).
 * ⚠️ Do NOT run until Supabase migration 120 (key_owners) is applied.
 */

import { config } from "dotenv";
import { existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";

const DRY_RUN = process.argv.includes("--dry-run");

// ── env ────────────────────────────────────────────────────────────────────────
const ENV_CANDIDATES = [
  process.env.DOTENV_PATH,
  "/var/www/da-platform/.env.production",
  ".env.production",
  ".env.local",
].filter(Boolean);
for (const p of ENV_CANDIDATES) {
  if (existsSync(p)) { config({ path: p }); console.log(`(env loaded from ${p})`); break; }
}
const pick = (...names) => { for (const n of names) if (process.env[n]) return process.env[n]; return undefined; };

const KO_HOST = pick("KEYOWNER_DB_HOST") || "127.0.0.1";
const KO_PORT = Number(pick("KEYOWNER_DB_PORT") || "3306");
const KO_USER = pick("KEYOWNER_DB_USER") || "root";
const KO_PASS = pick("KEYOWNER_DB_PASSWORD", "KEYOWNER_DB_PASS") || "";
const KO_NAME = pick("KEYOWNER_DB_NAME") || "da";

const SB_URL = pick("NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL");
const SB_KEY = pick("SUPABASE_SERVICE_ROLE_KEY");
if (!SB_URL || !SB_KEY) {
  console.error("Missing Supabase env (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).");
  process.exit(1);
}
const admin = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

const norm = (s) => (s ?? "").toString().trim();
const lc = (s) => norm(s).toLowerCase();

async function main() {
  console.log(`\n=== backfill-key-owners ${DRY_RUN ? "(DRY RUN — no writes)" : "(LIVE)"} ===`);

  // 1. Read legacy key_owners (local MySQL on the legacy box).
  let rows;
  try {
    const conn = await mysql.createConnection({
      host: KO_HOST, port: KO_PORT, user: KO_USER, password: KO_PASS, database: KO_NAME,
    });
    [rows] = await conn.execute(
      "SELECT username, user_key, dealer_id, user_email, user_full_name FROM key_owners"
    );
    await conn.end();
  } catch (e) {
    console.error(`\nCould not read legacy key_owners at ${KO_HOST}:${KO_PORT}/${KO_NAME}.`);
    console.error("Tunnel the legacy MySQL first (see the header). Error:", e.message);
    process.exit(1);
  }
  console.log(`Legacy key_owners: ${rows.length} rows`);

  // 2. Load all Supabase dealers → inventory_dealer_id + name maps.
  const dealers = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from("dealers")
      .select("dealer_id, inventory_dealer_id, name")
      .range(from, from + 999);
    if (error) { console.error("dealers read error:", error.message); process.exit(1); }
    dealers.push(...data);
    if (data.length < 1000) break;
  }
  const byInv = new Map();
  const byName = new Map();
  for (const d of dealers) {
    if (d.inventory_dealer_id) byInv.set(lc(d.inventory_dealer_id), d.dealer_id);
    if (d.name) {
      const k = lc(d.name);
      byName.set(k, byName.has(k) ? "__AMBIGUOUS__" : d.dealer_id); // never map an ambiguous name
    }
  }
  console.log(`Supabase dealers: ${dealers.length} (inv-id keys ${byInv.size}, name keys ${byName.size})`);

  // 3. Existing rows (idempotency reporting only — upsert handles the rest).
  const { data: existing } = await admin.from("key_owners").select("user_key");
  const existingKeys = new Set((existing ?? []).map((r) => r.user_key));

  // 4. Resolve each key owner → Supabase dealer_id.
  const toWrite = [];
  let matchedInv = 0, matchedName = 0, unmatched = 0, inserts = 0, updates = 0;
  for (const r of rows) {
    const legacyDealer = norm(r.dealer_id);
    let dealerId = null, method = null;

    if (legacyDealer && byInv.has(lc(legacyDealer))) {
      dealerId = byInv.get(lc(legacyDealer)); method = "inventory_dealer_id";
    } else {
      const nameHit = byName.get(lc(r.username));
      if (nameHit && nameHit !== "__AMBIGUOUS__") { dealerId = nameHit; method = "name==username"; }
    }

    if (!dealerId) {
      unmatched++;
      console.log(`  UNMATCHED  user="${r.username}" email=${r.user_email || "-"} legacy_dealer_id="${legacyDealer}" — map manually`);
      continue;
    }
    if (method === "inventory_dealer_id") matchedInv++; else matchedName++;
    const isUpdate = existingKeys.has(r.user_key);
    if (isUpdate) updates++; else inserts++;
    console.log(`  ${isUpdate ? "UPDATE" : "INSERT"}   user="${r.username}" -> dealer_id=${dealerId} (via ${method})`);
    toWrite.push({ username: r.username, user_key: r.user_key, dealer_id: dealerId });
  }

  // 5. Write (unless dry-run).
  if (!DRY_RUN && toWrite.length) {
    const { error } = await admin.from("key_owners").upsert(toWrite, { onConflict: "user_key" });
    if (error) { console.error("upsert error:", error.message); process.exit(1); }
  }

  // 6. Summary.
  console.log(`\n--- Summary ---`);
  console.log(`  matched by inventory_dealer_id : ${matchedInv}`);
  console.log(`  matched by name==username      : ${matchedName}`);
  console.log(`  unmatched (logged above)       : ${unmatched}`);
  console.log(`  ${DRY_RUN ? "would write" : "wrote"}: ${toWrite.length} (inserts ${inserts}, updates ${updates})`);
  if (DRY_RUN) console.log(`\nDRY RUN — nothing written. Re-run without --dry-run to apply.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
