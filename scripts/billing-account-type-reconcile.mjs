#!/usr/bin/env node
/**
 * billing-account-type-reconcile.mjs — pushes da-billing's plan into
 * the platform's dealers.account_type for confirmed mismatches.
 *
 * Walks active dealers, reads each da-billing template, and when
 * billing has a known subscription line item (sub-manual /
 * sub-auto-web / sub-auto-dms) the platform value disagrees with,
 * sets dealers.account_type = billing's productId. After updating
 * the row, PATCHes the dealer's HubSpot Company with the corrected
 * subscription_type + lifecyclestage so the new value lands on the
 * CRM immediately (without waiting for the nightly cron).
 *
 *   ssh -i ~/ssh/DA_Platform_2026.pem ubuntu@<da-platform>
 *   cd /var/www/da-platform
 *   node scripts/billing-account-type-reconcile.mjs                    # dry-run (default)
 *   node scripts/billing-account-type-reconcile.mjs --only <dealer_id> # dry-run for one
 *   node scripts/billing-account-type-reconcile.mjs --apply            # ⚠️ writes
 *
 * Source-of-truth note: this is a one-time legacy reconcile —
 * da-billing was migrated from FreshBooks with the accurate plan,
 * and the platform's account_type drifted. After this pass the
 * platform resumes as source of truth (operator edits the plan on
 * the platform → normal PATCH → fireDealerReliable → HubSpot).
 *
 * What it touches:
 *   - Only PLATFORM_UNDERREADS + MISMATCH from the audit (billing has
 *     a sub, platform disagrees). PLATFORM_OVERREADS is operator-
 *     decision — script never removes a plan.
 *   - dealers.account_type and the HubSpot Company subscription_type
 *     + lifecyclestage. Doesn't touch da-billing.
 */

import { config } from "dotenv";
config({ path: "/var/www/da-platform/.env.production" });

import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const ONLY_FLAG = process.argv.indexOf("--only");
const ONLY = ONLY_FLAG !== -1 ? process.argv[ONLY_FLAG + 1] : null;
const RATE_MS = 50;

const BILLING_BASE = process.env.BILLING_API_BASE ?? "https://billing.dealeraddendums.com/api/v1";
const BILLING_KEY = process.env.BILLING_API_KEY;
if (!BILLING_KEY) { console.error("BILLING_API_KEY not set"); process.exit(1); }

const HUBSPOT_BASE = "https://api.hubapi.com/crm/v3";
const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
if (!HUBSPOT_TOKEN) { console.error("HUBSPOT_PRIVATE_APP_TOKEN not set"); process.exit(1); }

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ── Constants mirrored from lib/hubspot.ts ────────────────────────────────
const LIFECYCLE = {
  CUSTOMER:           "customer",
  DEALER_TRIAL:       "60435067",
  ACCOUNT_DOWNGRADED: "108387744",
};

// productId → HubSpot subscription_type enum value
const SUB_TYPE_FROM_PRODUCT = {
  "sub-manual":   "Manual",
  "sub-auto-web": "Auto-Web",
  "sub-auto-dms": "Auto-DMS",
};

const PRODUCT_IDS = new Set(Object.keys(SUB_TYPE_FROM_PRODUCT));

// ── Helpers ────────────────────────────────────────────────────────────────

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

function subscriptionsOnTemplate(template) {
  const products = template?.products ?? [];
  return products.map(p => p?.productId).filter(id => id && PRODUCT_IDS.has(id));
}

async function patchHubspotCompany(hubspotId, properties) {
  const res = await fetch(`${HUBSPOT_BASE}/objects/companies/${encodeURIComponent(hubspotId)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HubSpot PATCH ${hubspotId} ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function fetchAllDealers(filterDealerId) {
  if (filterDealerId) {
    const { data, error } = await admin
      .from("dealers")
      .select("id, dealer_id, name, account_type, billing_customer_id, internal_id, hubspot_company_id, active, downgraded_at")
      .eq("dealer_id", filterDealerId)
      .maybeSingle();
    if (error) throw error;
    return data ? [data] : [];
  }
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("dealers")
      .select("id, dealer_id, name, account_type, billing_customer_id, internal_id, hubspot_company_id, active, downgraded_at")
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
  console.log(`Platform↔da-billing reconcile — ${APPLY ? "🔴 LIVE (--apply)" : "DRY RUN (no writes)"}${ONLY ? `  filter: dealer_id=${ONLY}` : ""}\n`);

  const dealers = await fetchAllDealers(ONLY);
  console.log(`Dealers to scan: ${dealers.length}`);

  const stats = { updates: 0, hubspot_ok: 0, hubspot_skipped: 0, hubspot_err: 0, billing_err: 0, skipped_overreads: 0, skipped_no_billing_customer: 0, ok: 0 };

  for (const d of dealers) {
    const customerId = d.billing_customer_id ?? d.internal_id;
    if (!customerId) {
      stats.skipped_no_billing_customer++;
      continue;
    }

    let template;
    try {
      template = await getBillingTemplate(customerId);
    } catch (err) {
      stats.billing_err++;
      console.error(`  ❌ billing ${d.dealer_id}: ${err.message}`);
      continue;
    }

    const billingIds = template ? subscriptionsOnTemplate(template) : [];
    const billingSub = billingIds[0] ?? null;
    const platformSub = subscriptionProductFromAccountType(d.account_type);

    if (billingSub === platformSub) {
      stats.ok++;
      continue;
    }
    if (!billingSub && platformSub) {
      // PLATFORM_OVERREADS — operator decision; never auto-clear.
      stats.skipped_overreads++;
      continue;
    }

    // PLATFORM_UNDERREADS or MISMATCH — push billing's plan into platform.
    const newAccountType = billingSub;
    const newSubscriptionType = SUB_TYPE_FROM_PRODUCT[newAccountType];
    // Lifecycle stays in step with subscription_type: any paying sub flips
    // the company from Trial to Customer. downgraded_at sticks unless an
    // operator clears it via the dealer-update PATCH.
    const newLifecycle = LIFECYCLE.CUSTOMER;

    console.log(`  UPDATE  ${d.dealer_id.padEnd(28)} ${(d.name ?? "—").padEnd(34).slice(0, 34)}  ${(d.account_type ?? "null").padEnd(16)} → ${newAccountType}`);

    if (!APPLY) {
      stats.updates++;
      continue;
    }

    // 1. Update Supabase row.
    const { error: uErr } = await admin
      .from("dealers")
      .update({ account_type: newAccountType, updated_at: new Date().toISOString() })
      .eq("id", d.id);
    if (uErr) {
      console.error(`    ❌ supabase update: ${uErr.message}`);
      continue;
    }
    stats.updates++;

    // 2. Push corrected fields to HubSpot. PATCH the stored id directly;
    //    skip silently if there isn't one yet (the nightly cron picks
    //    those up on its next run).
    if (!d.hubspot_company_id) {
      stats.hubspot_skipped++;
    } else {
      try {
        await patchHubspotCompany(d.hubspot_company_id, {
          subscription_type: newSubscriptionType,
          lifecyclestage: newLifecycle,
        });
        stats.hubspot_ok++;
      } catch (err) {
        stats.hubspot_err++;
        console.error(`    ⚠️  HubSpot resync ${d.dealer_id}: ${err.message}`);
      }
    }

    await new Promise(r => setTimeout(r, RATE_MS));
  }

  console.log("\n=== Summary ===");
  console.log(`  OK (matched):                     ${stats.ok}`);
  console.log(`  ${APPLY ? "Updated" : "Would update"} (account_type ← billing): ${stats.updates}`);
  if (APPLY) console.log(`    HubSpot resynced ok: ${stats.hubspot_ok}    skipped (no hubspot_company_id): ${stats.hubspot_skipped}    errors: ${stats.hubspot_err}`);
  console.log(`  Skipped (over-reads, operator decision): ${stats.skipped_overreads}`);
  console.log(`  Skipped (no billing customer id): ${stats.skipped_no_billing_customer}`);
  console.log(`  Billing errors:                   ${stats.billing_err}`);

  if (!APPLY) console.log("\n(dry-run — no writes performed. Re-run with --apply once the dry-run looks right.)");
  else console.log("\n✅ Apply complete. Spot-check a few dealers in the list (Subscription column) and in HubSpot.");
}

run().catch(err => { console.error("\nFATAL:", err.message); process.exit(1); });
