#!/usr/bin/env node
/**
 * backfill-converted-at.mjs — one-time, best-effort history fill for
 * dealers.converted_at (migration 095). For every PAYING, NON-MIGRATED
 * dealer that has no converted_at yet, stamp it from the dealer's
 * da-billing customer `createdAt`.
 *
 * Why createdAt is a faithful proxy: for self-serve dealers the da-billing
 * customer is created at the exact moment of conversion (POST /customers in
 * the subscription isConversion path). Migrated dealers were never trials —
 * their customer was created at migration, not conversion — so we SKIP
 * migration_status='migrated' and leave their converted_at NULL (they're not
 * in the trial funnel anyway).
 *
 * Idempotent: only touches rows where converted_at IS NULL. Re-runnable.
 *
 * --since CUTOFF (default 2026-05-01): only stamp when the da-billing customer
 * createdAt is ON OR AFTER this date. This excludes the 2026-04-02 FreshBooks→
 * da-billing BULK-MIGRATION date — ~1,521 legacy paying dealers had their
 * customer record created that day, which is NOT a real conversion. Those
 * dealers were never trials (not in the funnel), so leaving converted_at NULL
 * is correct. Only genuine self-serve conversions (customer created at
 * conversion time, post-go-live) get stamped. Confirmed via --dry-run 2026-06-08.
 *
 * Run on the da-platform EC2 (local copies have a truncated service-role key):
 *   ssh -i ~/ssh/DA_Platform_2026.pem ubuntu@<da-platform>
 *   cd /var/www/da-platform
 *   node scripts/backfill-converted-at.mjs --dry-run            # preview (May 1 cutoff)
 *   node scripts/backfill-converted-at.mjs                      # apply (May 1 cutoff)
 *   node scripts/backfill-converted-at.mjs --since=2026-05-01   # explicit cutoff
 *
 * Pacing: da-billing's nginx rate-limits /customers/* aggressively — a 200ms
 * (~5 req/s) pass still 429'd ~85% of requests. We pace at 400ms (~2.5 req/s)
 * AND retry each GET on 429/5xx with exponential backoff, so the run completes
 * cleanly instead of leaving most rows un-stamped. If you still see sustained
 * 429s, raise RATE_MS further.
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// Dependency-free env loading — dotenv isn't always present on the box.
function loadEnv(...names) {
  const out = Object.create(null);
  for (const p of ["/var/www/da-platform/.env.production", ".env.production"]) {
    try {
      const lines = readFileSync(p, "utf8").split(/\r?\n/);
      for (const line of lines) {
        for (const name of names) {
          const prefix = `${name}=`;
          if (line.startsWith(prefix) && !(name in out)) {
            out[name] = line.slice(prefix.length).trim().replace(/^["']|["']$/g, "");
          }
        }
      }
      if (Object.keys(out).length === names.length) return out;
    } catch { /* try next path */ }
  }
  for (const name of names) if (!(name in out) && process.env[name]) out[name] = process.env[name];
  return out;
}
const ENV = loadEnv("BILLING_API_KEY", "BILLING_API_BASE", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY");

const DRY_RUN = process.argv.includes("--dry-run");
const SINCE_FLAG = process.argv.find((a) => a.startsWith("--since="));
const SINCE = SINCE_FLAG ? SINCE_FLAG.slice("--since=".length) : "2026-05-01";
const SINCE_MS = new Date(`${SINCE}T00:00:00.000Z`).getTime();
if (Number.isNaN(SINCE_MS)) { console.error(`Invalid --since date: ${SINCE}`); process.exit(1); }
const RATE_MS = 400;
const MAX_RETRIES = 5;
const RETRY_BACKOFF_MS = [500, 1500, 4000, 8000, 15000];

const BILLING_BASE = ENV.BILLING_API_BASE ?? "https://billing.dealeraddendums.com/api/v1";
const BILLING_KEY = ENV.BILLING_API_KEY;
if (!BILLING_KEY) { console.error("BILLING_API_KEY not set"); process.exit(1); }
if (!ENV.NEXT_PUBLIC_SUPABASE_URL || !ENV.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Supabase env not set"); process.exit(1);
}

const admin = createClient(ENV.NEXT_PUBLIC_SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY);

// Mirror lib/print-eligibility.ts isPaidAccountType / lib/hubspot normalize:
// Manual / Auto-Web / Auto-DMS / PAYGo (± "$price" suffix) count as paying.
function isPaying(at) {
  if (!at) return false;
  const a = String(at).trim().toLowerCase().split("$")[0].trim();
  return (
    a === "manual" || a === "monthly subscription manual" || a === "sub-manual" ||
    a === "automatic web" || a === "automatic_web" || a === "auto-web" || a === "monthly subscription automatic web" || a === "sub-auto-web" ||
    a === "automatic dms" || a === "automatic_dms" || a === "auto-dms" || a === "monthly subscription automatic dms" || a === "sub-auto-dms" ||
    a === "paygo" || a === "pay go" || a === "pay-go"
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchAll(table, selectCols) {
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin.from(table).select(selectCols).range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

async function getCustomerCreatedAt(customerId) {
  let lastStatus = 0;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(`${BILLING_BASE}/customers/${encodeURIComponent(customerId)}`, {
      headers: { "X-API-Key": BILLING_KEY },
    });
    if (res.status === 404) return null;
    if (res.ok) {
      const parsed = await res.json().catch(() => null);
      const cust = parsed?.customer ?? parsed;
      return cust?.createdAt ?? null;
    }
    lastStatus = res.status;
    // Retry on rate-limit / transient server errors with exponential backoff.
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      await sleep(RETRY_BACKOFF_MS[attempt] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]);
      continue;
    }
    throw new Error(`getCustomer ${res.status}`);
  }
  throw new Error(`getCustomer ${lastStatus} after ${MAX_RETRIES} retries`);
}

async function main() {
  console.log(`backfill-converted-at — ${DRY_RUN ? "DRY RUN" : "APPLY"} — cutoff: customer createdAt >= ${SINCE}`);
  const dealers = await fetchAll(
    "dealers",
    "id, dealer_id, name, account_type, migration_status, converted_at, billing_customer_id, internal_id",
  );

  const candidates = dealers.filter(
    (d) =>
      d.converted_at == null &&
      d.migration_status !== "migrated" &&
      isPaying(d.account_type) &&
      (d.billing_customer_id || d.internal_id),
  );
  console.log(`${dealers.length} dealers total → ${candidates.length} candidates (paying, non-migrated, no converted_at, has billing key)`);

  let stamped = 0, noCreatedAt = 0, beforeCutoff = 0, errors = 0;
  for (const d of candidates) {
    const customerKey = d.billing_customer_id ?? d.internal_id;
    try {
      const createdAt = await getCustomerCreatedAt(customerKey);
      if (createdAt == null) {
        // Could be a 404 (no customer) or a customer without createdAt.
        noCreatedAt++;
        console.log(`  SKIP ${d.name} (${d.dealer_id}) — no createdAt on customer ${customerKey}`);
      } else if (new Date(createdAt).getTime() < SINCE_MS) {
        // Pre-cutoff: bulk-migration customers (esp. 2026-04-02) — not real
        // conversions. Leave converted_at NULL; they're not in the trial funnel.
        beforeCutoff++;
        console.log(`  BEFORE CUTOFF ${d.name} (${d.dealer_id}) → ${createdAt}`);
      } else {
        if (!DRY_RUN) {
          const { error } = await admin.from("dealers").update({ converted_at: createdAt }).eq("id", d.id);
          if (error) throw error;
        }
        stamped++;
        console.log(`  ${DRY_RUN ? "WOULD STAMP" : "STAMPED"} ${d.name} (${d.dealer_id}) → ${createdAt}`);
      }
    } catch (err) {
      errors++;
      console.error(`  ERROR ${d.name} (${d.dealer_id}): ${err instanceof Error ? err.message : err}`);
    }
    await sleep(RATE_MS);
  }

  console.log(`\nDone. stamped=${stamped} beforeCutoff(<${SINCE})=${beforeCutoff} noCreatedAt/404=${noCreatedAt} errors=${errors}`);
  if (DRY_RUN) console.log("(dry run — no writes performed)");
}

main().catch((e) => { console.error(e); process.exit(1); });
