#!/usr/bin/env node
/**
 * apply-migration-058.mjs
 *
 * Migrates vehicle_addendum_items → addendum_data via the Supabase JS client.
 * Mirrors the canonical SQL in supabase/migrations/058_consolidate_addendum_data.sql
 * — use this script when direct psql access isn't available.
 *
 * Idempotency: pre-loads the set of existing legacy_id values from
 * addendum_data and filters them out client-side. PostgREST can't infer
 * the partial unique index from migration 046 for ON CONFLICT, so plain
 * INSERT + client-side filter is the practical path.
 *
 * Idempotent: dedupes by (dealer_id, legacy_id). Re-running is safe.
 *
 * Run:
 *   node scripts/apply-migration-058.mjs           # full run
 *   node scripts/apply-migration-058.mjs --dry-run # report counts only
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as path from "node:path";
import { argv, exit } from "node:process";

for (const name of [".env.local", ".env.production", ".env"]) {
  dotenv.config({ path: path.join(process.cwd(), name) });
}

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  exit(1);
}

const DRY_RUN = argv.includes("--dry-run");
const PAGE = 1000;
const UPSERT_BATCH = 500;

const sb = createClient(SUPA_URL, SUPA_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (m) => console.log(`[${now()}] ${m}`);

// ── Pre-check counts ─────────────────────────────────────────────────────────
const { count: vaiCount, error: e1 } = await sb
  .from("vehicle_addendum_items")
  .select("*", { count: "exact", head: true });
if (e1) { console.error(`vehicle_addendum_items count error: ${e1.message}`); exit(1); }

const { count: adBefore, error: e2 } = await sb
  .from("addendum_data")
  .select("*", { count: "exact", head: true })
  .not("legacy_id", "is", null);
if (e2) { console.error(`addendum_data count error: ${e2.message}`); exit(1); }

log(`vehicle_addendum_items rows: ${vaiCount}`);
log(`addendum_data rows with legacy_id NOT NULL (before): ${adBefore}`);
if (DRY_RUN) { log("Dry run — no writes performed."); exit(0); }

// ── Load dealer.id → dealer.dealer_id map ────────────────────────────────────
const dealerById = new Map();
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb
    .from("dealers")
    .select("id, dealer_id")
    .range(from, from + 999);
  if (error) { console.error(`dealers page error: ${error.message}`); exit(1); }
  const rows = data ?? [];
  for (const d of rows) dealerById.set(d.id, d.dealer_id);
  if (rows.length < 1000) break;
}
log(`Loaded ${dealerById.size} dealers for legacy_dealer_id lookup`);

// ── Load existing legacy_ids in addendum_data for client-side dedup ──────────
// PostgREST can't pass the partial-index predicate to Postgres for ON CONFLICT
// inference, so we filter duplicates here. The partial unique index in the
// DB still guards against accidental double-inserts.
const existingLegacyIds = new Set();
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb
    .from("addendum_data")
    .select("legacy_id")
    .not("legacy_id", "is", null)
    .order("legacy_id", { ascending: true })
    .range(from, from + 999);
  if (error) { console.error(`existing legacy_id page error: ${error.message}`); exit(1); }
  const rows = data ?? [];
  for (const r of rows) existingLegacyIds.add(r.legacy_id);
  if (rows.length < 1000) break;
}
log(`Loaded ${existingLegacyIds.size} existing legacy_id values for dedup`);

// ── Page through vehicle_addendum_items and insert ───────────────────────────
let totalInserted = 0;
let totalSkippedNoDealer = 0;
let totalSkippedNoAurora = 0;
let totalErrored = 0;

for (let from = 0; ; from += PAGE) {
  const { data, error } = await sb
    .from("vehicle_addendum_items")
    .select("dealer_id, vehicle_id, aurora_id, vin, item_name, item_price, created_at_aurora, updated_at_aurora, synced_at")
    .order("id", { ascending: true })
    .range(from, from + PAGE - 1);
  if (error) { console.error(`vehicle_addendum_items page error: ${error.message}`); exit(1); }
  const rows = data ?? [];
  if (rows.length === 0) break;

  // Build upsert payload
  const payload = [];
  for (const r of rows) {
    if (r.aurora_id == null) { totalSkippedNoAurora++; continue; }
    const legacyDealerId = dealerById.get(r.dealer_id);
    if (!legacyDealerId) { totalSkippedNoDealer++; continue; }
    payload.push({
      dealer_id: r.dealer_id,
      legacy_dealer_id: legacyDealerId,
      vehicle_id: r.vehicle_id,
      vin_number: r.vin,
      item_name: r.item_name ?? "(unknown)",
      item_price: r.item_price == null ? null : String(r.item_price),
      legacy_id: Number(r.aurora_id),
      document_type: "addendum",
      created_at: r.created_at_aurora ?? r.synced_at ?? new Date().toISOString(),
      updated_at: r.updated_at_aurora ?? r.synced_at ?? new Date().toISOString(),
    });
  }

  // Upsert in sub-batches
  for (let i = 0; i < payload.length; i += UPSERT_BATCH) {
    const batch = payload.slice(i, i + UPSERT_BATCH);
    // Plain INSERT — PostgREST upsert with ON CONFLICT can't infer the
    // partial unique index (legacy_id WHERE legacy_id IS NOT NULL), so
    // we dedup client-side using the existingLegacyIds set built once at
    // startup. The partial unique index still guards against accidental
    // duplicates at the DB layer.
    const fresh = batch.filter(r => !existingLegacyIds.has(r.legacy_id));
    if (fresh.length === 0) { continue; }
    const { error: insErr } = await sb
      .from("addendum_data")
      .insert(fresh);
    if (insErr) {
      totalErrored += fresh.length;
      console.error(`insert error at offset ${from + i}: ${insErr.message}`);
      continue;
    }
    for (const r of fresh) existingLegacyIds.add(r.legacy_id);
    totalInserted += fresh.length;
  }

  log(`page ${from / PAGE} done — running totals: inserted=${totalInserted} skipped_no_dealer=${totalSkippedNoDealer} skipped_no_aurora=${totalSkippedNoAurora} errored=${totalErrored}`);

  if (rows.length < PAGE) break;
}

// ── Post-check ───────────────────────────────────────────────────────────────
const { count: adAfter } = await sb
  .from("addendum_data")
  .select("*", { count: "exact", head: true })
  .not("legacy_id", "is", null);

log("─".repeat(60));
log(`DONE.`);
log(`vehicle_addendum_items rows:                  ${vaiCount}`);
log(`addendum_data rows w/ legacy_id (before):     ${adBefore}`);
log(`addendum_data rows w/ legacy_id (after):      ${adAfter}`);
log(`net new addendum_data rows:                   ${adAfter - adBefore}`);
log(`upserted (this run, includes pre-existing):   ${totalInserted}`);
log(`skipped (no dealer match):                    ${totalSkippedNoDealer}`);
log(`skipped (aurora_id null):                     ${totalSkippedNoAurora}`);
log(`errored:                                       ${totalErrored}`);

if (totalErrored > 0) exit(1);
exit(0);
