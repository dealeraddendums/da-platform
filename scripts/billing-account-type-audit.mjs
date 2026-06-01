#!/usr/bin/env node
/**
 * billing-account-type-audit.mjs — READ-ONLY. Compares each active
 * dealer's platform `account_type` to its da-billing template's
 * subscription line item, surfacing drift.
 *
 * Background: the legacy migration set `account_type` from Aurora's
 * `ACCOUNT_TYPE` and defaulted to "Standard" when null. "Standard"
 * isn't in `subscriptionLabel()`'s map, so the dealers list renders
 * those rows as "Free" — and isPayingAccount() returns false, so the
 * Phase-14 HubSpot sync classifies them as Trial. Meanwhile da-billing
 * (migrated from FreshBooks) holds the accurate plan.
 *
 * Usage (run on da-platform EC2 — local has a truncated service-role key):
 *   ssh -i ~/ssh/DA_Platform_2026.pem ubuntu@<da-platform>
 *   cd /var/www/da-platform
 *   node scripts/billing-account-type-audit.mjs                 # full audit
 *   node scripts/billing-account-type-audit.mjs --list-mismatches  # print every bad row
 *   node scripts/billing-account-type-audit.mjs --limit 100        # sample first 100
 *
 * Output buckets:
 *   PLATFORM_UNDERREADS — billing has an active subscription line
 *                         item, platform account_type is free/null/
 *                         Standard/unmapped. Display + HubSpot wrong.
 *   PLATFORM_OVERREADS  — platform has a known plan (sub-*), billing
 *                         template has no subscription line item.
 *                         Under-billing risk; operator decision.
 *   MISMATCH            — both have plans, different tiers.
 *   OK                  — match (or both none).
 *   NO_BILLING_CUSTOMER — no billing_customer_id or internal_id set;
 *                         dealer hasn't been provisioned in da-billing.
 *
 * Pacing: 50ms per da-billing GET (~20 req/s, same as backfill).
 */

import { config } from "dotenv";
config({ path: "/var/www/da-platform/.env.production" });

import { createClient } from "@supabase/supabase-js";

const LIST = process.argv.includes("--list-mismatches");
const LIMIT_FLAG = process.argv.indexOf("--limit");
const LIMIT = LIMIT_FLAG !== -1 ? Number(process.argv[LIMIT_FLAG + 1]) : Infinity;
const RATE_MS = 50;

const BILLING_BASE = process.env.BILLING_API_BASE ?? "https://billing.dealeraddendums.com/api/v1";
const BILLING_KEY = process.env.BILLING_API_KEY;
if (!BILLING_KEY) { console.error("BILLING_API_KEY not set"); process.exit(1); }

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ── Helpers ────────────────────────────────────────────────────────────────

// Mirror of lib/billing.ts subscriptionDescriptorFor — keeps the script
// self-contained so it can run without ts-node. Returns the canonical
// productId ('sub-manual' / 'sub-auto-web' / 'sub-auto-dms') or null.
const PRODUCT_IDS = new Set(["sub-manual", "sub-auto-web", "sub-auto-dms"]);

function subscriptionProductFromAccountType(accountType) {
  if (!accountType) return null;
  const a = String(accountType).trim().toLowerCase();
  if (a === "manual" || a === "monthly subscription manual" || a === "sub-manual") return "sub-manual";
  if (a === "automatic web" || a === "automatic_web" ||
      a === "monthly subscription automatic web" || a === "sub-auto-web") return "sub-auto-web";
  if (a === "automatic dms" || a === "automatic_dms" ||
      a === "monthly subscription automatic dms" || a === "sub-auto-dms") return "sub-auto-dms";
  return null;
}

async function getBillingTemplate(customerId) {
  const res = await fetch(`${BILLING_BASE}/templates/customer/${encodeURIComponent(customerId)}`, {
    headers: { "X-API-Key": BILLING_KEY },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`getTemplate ${customerId} ${res.status}: ${text.slice(0, 200)}`);
  }
  const parsed = await res.json();
  return parsed?.template ?? null;
}

/** Subscription productIds present on the template (filtered to the three known tiers). */
function subscriptionsOnTemplate(template) {
  const products = template?.products ?? [];
  const ids = [];
  for (const p of products) {
    if (p?.productId && PRODUCT_IDS.has(p.productId)) ids.push(p.productId);
  }
  return ids;
}

async function fetchAllDealers() {
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("dealers")
      .select("id, dealer_id, name, account_type, billing_customer_id, internal_id, active")
      .eq("active", true)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function run() {
  console.log("Platform↔da-billing account_type audit — READ ONLY (no writes)\n");

  const dealers = await fetchAllDealers();
  console.log(`Active dealers: ${dealers.length}`);

  const buckets = {
    OK:                  [],
    NO_BILLING_CUSTOMER: [],
    PLATFORM_UNDERREADS: [],   // billing has sub, platform doesn't
    PLATFORM_OVERREADS:  [],   // platform has plan, billing doesn't
    MISMATCH:            [],   // both have plan, different tier
    BILLING_ERROR:       [],
  };

  let processed = 0;
  for (const d of dealers) {
    if (processed >= LIMIT) break;
    processed++;

    const customerId = d.billing_customer_id ?? d.internal_id;
    if (!customerId) {
      buckets.NO_BILLING_CUSTOMER.push({ d, billingSub: null, platformSub: subscriptionProductFromAccountType(d.account_type) });
      continue;
    }

    let template;
    try {
      template = await getBillingTemplate(customerId);
    } catch (err) {
      buckets.BILLING_ERROR.push({ d, err: err.message });
      continue;
    }

    const billingIds = template ? subscriptionsOnTemplate(template) : [];
    const billingSub = billingIds[0] ?? null;            // first known sub line item
    const platformSub = subscriptionProductFromAccountType(d.account_type);

    if (billingSub === platformSub) {
      buckets.OK.push({ d, billingSub, platformSub });
    } else if (billingSub && !platformSub) {
      buckets.PLATFORM_UNDERREADS.push({ d, billingSub, platformSub });
    } else if (!billingSub && platformSub) {
      buckets.PLATFORM_OVERREADS.push({ d, billingSub, platformSub });
    } else {
      buckets.MISMATCH.push({ d, billingSub, platformSub });
    }

    if (processed % 100 === 0) process.stdout.write(`\r  processed: ${processed}/${dealers.length}…`);
    await new Promise(r => setTimeout(r, RATE_MS));
  }
  process.stdout.write("\n");

  // ── Report ─────────────────────────────────────────────────────────────
  const fmt = (e) => `${(e.d.dealer_id ?? "—").padEnd(28)} ${(e.d.name ?? "—").padEnd(38).slice(0, 38)}  platform=${e.platformSub ?? `(${e.d.account_type ?? "null"})`}  billing=${e.billingSub ?? "—"}`;

  console.log("\n=== Counts ===");
  console.log(`  OK (both match, or both none):     ${buckets.OK.length}`);
  console.log(`  PLATFORM_UNDERREADS (display+HS wrong): ${buckets.PLATFORM_UNDERREADS.length}`);
  console.log(`  PLATFORM_OVERREADS (under-billing risk): ${buckets.PLATFORM_OVERREADS.length}`);
  console.log(`  MISMATCH (different tiers):        ${buckets.MISMATCH.length}`);
  console.log(`  NO_BILLING_CUSTOMER:               ${buckets.NO_BILLING_CUSTOMER.length}`);
  console.log(`  BILLING_ERROR:                     ${buckets.BILLING_ERROR.length}`);

  function dumpSample(label, list, n = 10) {
    if (list.length === 0) return;
    console.log(`\n--- ${label} (showing ${Math.min(n, list.length)} of ${list.length}) ---`);
    for (const e of list.slice(0, n)) console.log(`  ${fmt(e)}`);
  }

  if (LIST) {
    dumpSample("PLATFORM_UNDERREADS — fixable, billing leads", buckets.PLATFORM_UNDERREADS, 9999);
    dumpSample("MISMATCH — fixable, billing leads",            buckets.MISMATCH, 9999);
    dumpSample("PLATFORM_OVERREADS — operator decision",       buckets.PLATFORM_OVERREADS, 9999);
    dumpSample("BILLING_ERROR",                                buckets.BILLING_ERROR, 9999);
  } else {
    dumpSample("PLATFORM_UNDERREADS — fixable, billing leads", buckets.PLATFORM_UNDERREADS);
    dumpSample("MISMATCH — fixable, billing leads",            buckets.MISMATCH);
    dumpSample("PLATFORM_OVERREADS — operator decision",       buckets.PLATFORM_OVERREADS);
    if (buckets.BILLING_ERROR.length) {
      console.log(`\n--- BILLING_ERROR (showing ${Math.min(5, buckets.BILLING_ERROR.length)} of ${buckets.BILLING_ERROR.length}) ---`);
      for (const e of buckets.BILLING_ERROR.slice(0, 5)) console.log(`  ${e.d.dealer_id}  ${e.err}`);
    }
  }

  console.log("\n(Read-only — no writes. Use scripts/billing-account-type-reconcile.mjs --apply to push billing's plan into dealers.account_type for PLATFORM_UNDERREADS + MISMATCH.)");
}

run().catch(err => { console.error("\nFATAL:", err.message); process.exit(1); });
