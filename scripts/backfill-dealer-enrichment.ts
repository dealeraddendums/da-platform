/**
 * Backfill Google Places enrichment for EXISTING trial dealers that are missing
 * a phone number or a street address.
 *
 *   npx tsx scripts/backfill-dealer-enrichment.ts --dry-run          # look, write nothing
 *   npx tsx scripts/backfill-dealer-enrichment.ts --dry-run --limit=20
 *   npx tsx scripts/backfill-dealer-enrichment.ts --limit=50         # live, 50 dealers
 *   npx tsx scripts/backfill-dealer-enrichment.ts                    # live, everything eligible
 *
 * ⚠️ NOT auto-run and not wired to any cron. Every request costs money (Places
 * API (New) bills per call by field-mask tier) so the operator decides when and
 * how many. ALWAYS --dry-run first: it performs the same Places lookups (so the
 * cost is identical) but writes nothing, which is how you see what would change.
 *
 * ⚠️ ALLAN'S DECISION, 2026-09-15: DO NOT run a fleet-wide backfill of the
 * existing trial dealers and dealers. Enrichment is for NEW signups only — the
 * signup hook handles those automatically. That leaves this script with two
 * legitimate uses, both narrow and both deliberate:
 *
 *   1. RETRY a new signup whose lookup failed (quota, outage, timeout). Those
 *      land as enrichment_status='error' and are the one status this script
 *      always re-attempts:
 *        npx tsx scripts/backfill-dealer-enrichment.ts --dealer=<uuid>
 *   2. A one-off, explicitly-scoped run if a batch of signups arrived while the
 *      API key was missing.
 *
 * Running it with no --dealer and no --limit would sweep every eligible active
 * Trial dealer, which is exactly the fleet-wide backfill that was declined.
 * Don't, unless Allan asks for it.
 *
 * Flags:
 *   --dry-run          score + report, no writes (Supabase or HubSpot)
 *   --limit=N          stop after N dealers (default: no limit)
 *   --qps=N            requests/second ceiling (default 5)
 *   --include-paid     also enrich non-Trial dealers (default: Trial only)
 *   --redo             re-run dealers that already have a dealer_enrichment row
 *                      (default: skip them, EXCEPT rows with status 'error',
 *                      which are always retried — that's what the status is for)
 *   --dealer=<uuid>    just this one dealer (ignores the eligibility filter)
 */

import dotenv from "dotenv";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import { enrichDealer } from "../lib/enrichment/dealerEnrich";
import { placesConfigured } from "../lib/enrichment/places";

// Load env the same way the other scripts do (.env.local for a workstation run,
// .env.production when run on the box).
dotenv.config({ path: path.resolve(process.cwd(), ".env.production") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const val = (f: string): string | null => {
  const hit = args.find(a => a.startsWith(`${f}=`));
  return hit ? hit.slice(f.length + 1) : null;
};

const DRY_RUN = has("--dry-run");
const REDO = has("--redo");
const INCLUDE_PAID = has("--include-paid");
const LIMIT = val("--limit") ? Math.max(1, parseInt(val("--limit")!, 10)) : null;
const ONE_DEALER = val("--dealer");

/**
 * Requests per second ceiling.
 *
 * Places API (New) allows far more than this (the per-project default is in the
 * hundreds of QPM), so 5/s is a deliberate self-limit rather than a compliance
 * one: a backfill is never urgent, and a runaway loop against a metered API is
 * the expensive kind of mistake. Raise it with --qps only if a large run is
 * actually too slow.
 */
const QPS = val("--qps") ? Math.max(1, Math.min(20, parseInt(val("--qps")!, 10))) : 5;
const MIN_INTERVAL_MS = Math.ceil(1000 / QPS);

interface DealerRow {
  id: string;
  dealer_id: string;
  name: string | null;
  zip: string | null;
  phone: string | null;
  address: string | null;
  primary_contact_email: string | null;
  account_type: string | null;
  account_purpose: string | null;
  is_test: boolean | null;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  if (!placesConfigured()) {
    console.error("Missing GOOGLE_PLACES_API_KEY — every lookup would record status='error'. Set it and re-run.");
    process.exit(1);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin: any = createClient(url, key, { auth: { persistSession: false } });

  console.log(`\nDealer enrichment backfill — ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}`);
  console.log(`  scope: ${ONE_DEALER ? `dealer ${ONE_DEALER}` : INCLUDE_PAID ? "all active dealers" : "active Trial dealers"}`);
  console.log(`  rate:  ${QPS} req/s (${MIN_INTERVAL_MS}ms apart)${LIMIT ? `, limit ${LIMIT}` : ""}`);
  console.log(`  redo:  ${REDO ? "yes — re-enrich dealers that already have a row" : "no — skip enriched dealers (errors always retried)"}\n`);

  // ── Candidates. PostgREST silently clamps any read to 1000 rows, so page
  //    with .range() rather than .limit() — a 2,000-dealer fleet would
  //    otherwise be quietly truncated (a repeat of the 2026-08-07 sort bug).
  const candidates: DealerRow[] = [];
  const PAGE = 500;
  for (let from = 0; ; from += PAGE) {
    let q = admin
      .from("dealers")
      .select("id, dealer_id, name, zip, phone, address, primary_contact_email, account_type, account_purpose, is_test")
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (ONE_DEALER) q = q.eq("id", ONE_DEALER);
    else {
      q = q.eq("active", true);
      if (!INCLUDE_PAID) q = q.eq("account_type", "Trial");
    }
    const { data, error } = await q as { data: DealerRow[] | null; error: { message: string } | null };
    if (error) { console.error("dealer read failed:", error.message); process.exit(1); }
    const page = data ?? [];
    candidates.push(...page);
    if (page.length < PAGE || ONE_DEALER) break;
  }

  // Already-enriched set (one read, not one per dealer).
  const { data: existing } = await admin
    .from("dealer_enrichment")
    .select("dealer_uuid, enrichment_status") as
    { data: { dealer_uuid: string; enrichment_status: string }[] | null };
  const enrichedStatus = new Map((existing ?? []).map(e => [e.dealer_uuid, e.enrichment_status]));

  // ── Eligibility: missing a phone OR a street address is the whole point.
  const eligible = candidates.filter(d => {
    if (!d.name?.trim()) return false;
    if (!ONE_DEALER) {
      const missing = !d.phone?.trim() || !d.address?.trim();
      if (!missing) return false;
    }
    const prior = enrichedStatus.get(d.id);
    // 'error' rows are a retry queue — always eligible.
    if (prior && prior !== "error" && !REDO) return false;
    return true;
  });

  const work = LIMIT ? eligible.slice(0, LIMIT) : eligible;
  console.log(`${candidates.length} dealers in scope → ${eligible.length} eligible (missing phone or address) → processing ${work.length}\n`);
  if (work.length === 0) { console.log("Nothing to do.\n"); return; }

  const tally: Record<string, number> = { confirmed: 0, needs_review: 0, no_match: 0, error: 0 };
  let filledDealer = 0, patchedHubspot = 0, skippedHubspot = 0;
  const detail: string[] = [];
  const started = Date.now();

  for (let i = 0; i < work.length; i++) {
    const d = work[i];
    const t0 = Date.now();

    const outcome = await enrichDealer({
      dealerUuid: d.id,
      dealershipName: d.name!,
      zip: d.zip,
      contactEmail: d.primary_contact_email,
    }, { dryRun: DRY_RUN });

    tally[outcome.status] = (tally[outcome.status] ?? 0) + 1;
    if (outcome.appliedToDealer.length > 0) filledDealer++;
    if (outcome.hubspotCompanyId) patchedHubspot++;
    else if (outcome.hubspotSkipped) skippedHubspot++;

    const purpose = d.account_purpose ?? (d.is_test ? "test" : "real");
    const line =
      `${String(i + 1).padStart(4)}. ${(d.name ?? "").slice(0, 34).padEnd(34)} ` +
      `${outcome.status.padEnd(12)} ` +
      `score=${outcome.nameScore != null ? outcome.nameScore.toFixed(2) : " —  "} ` +
      `fill=[${outcome.appliedToDealer.join(",")}]`.padEnd(30) +
      `hs=${outcome.hubspotCompanyId ?? (outcome.hubspotSkipped ?? "").slice(0, 34)}` +
      (purpose !== "real" ? `  [${purpose}]` : "");
    console.log(line);
    if (outcome.status === "needs_review") {
      detail.push(`  ${d.name} (${d.dealer_id}) → Google: "${outcome.matchedName}" score ${outcome.nameScore?.toFixed(2)}`);
    }

    // Rate limit: pace on ELAPSED time, so a slow request doesn't add its
    // latency to the delay and halve the effective throughput.
    if (i < work.length - 1) {
      const wait = MIN_INTERVAL_MS - (Date.now() - t0);
      if (wait > 0) await sleep(wait);
    }
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${"─".repeat(72)}`);
  console.log(`Summary${DRY_RUN ? " (DRY RUN — nothing was written)" : ""} — ${work.length} dealers in ${secs}s`);
  console.log(`${"─".repeat(72)}`);
  console.log(`  confirmed                  ${String(tally.confirmed).padStart(5)}   (safe to use; filled blank dealer fields)`);
  console.log(`  needs_review               ${String(tally.needs_review).padStart(5)}   (zip matched, name differs — a human must vet)`);
  console.log(`  no_match                   ${String(tally.no_match).padStart(5)}   (nothing credible found; nothing written)`);
  console.log(`  error                      ${String(tally.error).padStart(5)}   (lookup failed; re-run to retry)`);
  console.log(`  ${"·".repeat(68)}`);
  console.log(`  dealers with fields filled ${String(filledDealer).padStart(5)}`);
  console.log(`  HubSpot companies patched  ${String(patchedHubspot).padStart(5)}`);
  console.log(`  HubSpot writes skipped     ${String(skippedHubspot).padStart(5)}   (test/demo dealer, no linked company, or already populated)`);
  console.log(`  Places requests billed     ${String(work.length).padStart(5)}   (one text search per dealer)`);
  if (detail.length > 0) {
    console.log(`\nNeeds review — verify before anyone calls:`);
    for (const l of detail.slice(0, 40)) console.log(l);
    if (detail.length > 40) console.log(`  … and ${detail.length - 40} more (see /admin/trial-signups or dealer_enrichment)`);
  }
  console.log("");
}

void main().catch(err => { console.error("\nbackfill failed:", err); process.exit(1); });
