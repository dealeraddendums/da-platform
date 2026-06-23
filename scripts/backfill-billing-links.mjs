#!/usr/bin/env node
/**
 * backfill-billing-links.mjs — Link groups and dealers in DA Platform to their
 * existing da-billing customer records by populating billing_customer_id.
 *
 * Matching strategy:
 *   Groups:  customer.isGroup === true, matched by company OR name (case-insensitive)
 *   Dealers: customer.isGroup !== true, matched first by email, then by company name
 *
 * Categories (per entity):
 *   synced        — billing_customer_id already set and found in da-billing
 *   link-missing  — da-billing has a match but billing_customer_id is null → backfill candidate
 *   ambiguous     — multiple da-billing customers match → flagged, skipped on write
 *   genuinely-new — no da-billing customer found
 *   mismatch      — billing_customer_id set but not found in da-billing
 *
 * Usage (run from da-platform/):
 *   node scripts/backfill-billing-links.mjs           # dry-run (default)
 *   node scripts/backfill-billing-links.mjs --apply   # write billing_customer_id
 *
 * Writes billing-links-audit.csv to the current working directory.
 */

import { config } from "dotenv";
config({ path: "/var/www/da-platform/.env.production" });

import { createClient } from "@supabase/supabase-js";
import { createWriteStream } from "fs";
import { resolve } from "path";

// ── Config ────────────────────────────────────────────────────────────────────

const APPLY = process.argv.includes("--apply");

const BILLING_BASE = process.env.BILLING_API_BASE ?? "https://billing.dealeraddendums.com/api/v1";
const BILLING_KEY  = process.env.BILLING_API_KEY;
if (!BILLING_KEY) { console.error("BILLING_API_KEY not set"); process.exit(1); }

const SUPABASE_URL  = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set");
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Supabase pagination helper (matches backfill-hubspot.mjs) ─────────────────

async function fetchAll(table, selectCols, filters = []) {
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = admin.from(table).select(selectCols).range(from, from + PAGE - 1);
    for (const [col, op, val] of filters) {
      if (op === "neq") q = q.neq(col, val);
      else if (op === "is")  q = q.is(col, val);
      else                   q = q.eq(col, val);
    }
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

// ── da-billing fetch (paginated) ──────────────────────────────────────────────

async function fetchAllBillingCustomers() {
  const all = [];
  let page = 1;
  const pageSize = 500;

  while (true) {
    const url = `${BILLING_BASE}/customers?pageSize=${pageSize}&page=${page}&status=all`;
    const res = await fetch(url, { headers: { "X-API-Key": BILLING_KEY } });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`da-billing GET /customers?page=${page} → ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = await res.json();
    const customers = json.customers ?? [];
    all.push(...customers);
    if (all.length >= json.total || customers.length < pageSize) break;
    page++;
  }

  return all;
}

// ── Normalisation helpers ─────────────────────────────────────────────────────

function norm(s) {
  return (s ?? "").trim().toLowerCase();
}

// ── CSV writer ────────────────────────────────────────────────────────────────

function csvRow(fields) {
  return fields.map(f => {
    const s = String(f ?? "").replace(/"/g, '""');
    return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s}"` : s;
  }).join(",") + "\n";
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`Billing link backfill — ${APPLY ? "APPLY (writes enabled)" : "DRY RUN (no writes)"}`);
  console.log(`  Billing base: ${BILLING_BASE}`);

  // 1. Fetch da-billing customers
  console.log("\nFetching da-billing customers...");
  const billingCustomers = await fetchAllBillingCustomers();
  console.log(`  ${billingCustomers.length} billing customers fetched`);

  // Index by id for fast lookup
  const billingById = new Map(billingCustomers.map(c => [c.id, c]));

  // Partition into group / dealer customers
  const billingGroups  = billingCustomers.filter(c => c.isGroup === true);
  const billingDealers = billingCustomers.filter(c => c.isGroup !== true);

  console.log(`  ${billingGroups.length} group customers, ${billingDealers.length} dealer customers`);

  // 2. Fetch platform groups
  console.log("\nFetching platform groups...");
  const platformGroups = await fetchAll("groups", "id, name, billing_customer_id");
  console.log(`  ${platformGroups.length} groups`);

  // 3. Fetch platform dealers (exclude test/demo)
  console.log("\nFetching platform dealers...");
  const platformDealers = await fetchAll(
    "dealers",
    "id, name, primary_contact_email, billing_customer_id, group_id, is_test, account_purpose",
    [["is_test", "neq", true]],
  );
  // Also filter account_purpose != 'test' in memory (Supabase neq doesn't handle null rows reliably for text)
  const realDealers = platformDealers.filter(d => d.account_purpose !== "test");
  console.log(`  ${realDealers.length} non-test dealers`);

  // ── Build lookup indexes ───────────────────────────────────────────────────

  // For group billing customers: index by norm(company) and norm(name)
  // Map: normalised string → array of matching billing customers
  function buildNameIndex(customers) {
    const idx = new Map();
    for (const c of customers) {
      for (const key of [norm(c.company), norm(c.name)]) {
        if (!key) continue;
        if (!idx.has(key)) idx.set(key, []);
        idx.get(key).push(c);
      }
    }
    return idx;
  }

  const groupNameIdx  = buildNameIndex(billingGroups);
  const dealerNameIdx = buildNameIndex(billingDealers);

  // For dealer billing customers: email index
  const dealerEmailIdx = new Map();
  for (const c of billingDealers) {
    const e = norm(c.email);
    if (!e) continue;
    if (!dealerEmailIdx.has(e)) dealerEmailIdx.set(e, []);
    dealerEmailIdx.get(e).push(c);
  }

  // ── Results accumulator ────────────────────────────────────────────────────

  const results = []; // { entity_type, platform_id, platform_name, da_billing_id, da_billing_company, category, match_reason }

  // ── Match groups ──────────────────────────────────────────────────────────

  console.log("\nMatching groups...");

  for (const g of platformGroups) {
    const existing = g.billing_customer_id;

    // Already linked → verify it exists in da-billing
    if (existing) {
      if (billingById.has(existing)) {
        const c = billingById.get(existing);
        results.push({
          entity_type: "group",
          platform_id: g.id,
          platform_name: g.name,
          da_billing_id: existing,
          da_billing_company: c.company ?? c.name ?? "",
          category: "synced",
          match_reason: "existing_id_valid",
        });
      } else {
        results.push({
          entity_type: "group",
          platform_id: g.id,
          platform_name: g.name,
          da_billing_id: existing,
          da_billing_company: "",
          category: "mismatch",
          match_reason: "existing_id_not_found_in_billing",
        });
      }
      continue;
    }

    // Not linked — try to find a match by name
    const nameKey = norm(g.name);
    const matches = groupNameIdx.get(nameKey) ?? [];
    // Deduplicate by id (same customer can appear via company AND name)
    const unique = [...new Map(matches.map(c => [c.id, c])).values()];

    if (unique.length === 0) {
      results.push({
        entity_type: "group",
        platform_id: g.id,
        platform_name: g.name,
        da_billing_id: "",
        da_billing_company: "",
        category: "genuinely-new",
        match_reason: "no_billing_customer_found",
      });
    } else if (unique.length === 1) {
      results.push({
        entity_type: "group",
        platform_id: g.id,
        platform_name: g.name,
        da_billing_id: unique[0].id,
        da_billing_company: unique[0].company ?? unique[0].name ?? "",
        category: "link-missing",
        match_reason: "name_match",
      });
    } else {
      results.push({
        entity_type: "group",
        platform_id: g.id,
        platform_name: g.name,
        da_billing_id: unique.map(c => c.id).join("|"),
        da_billing_company: unique.map(c => c.company ?? c.name ?? "").join("|"),
        category: "ambiguous",
        match_reason: `${unique.length}_name_matches`,
      });
    }
  }

  // ── Match dealers ──────────────────────────────────────────────────────────

  console.log("Matching dealers...");

  for (const d of realDealers) {
    const existing = d.billing_customer_id;

    // Already linked → verify
    if (existing) {
      if (billingById.has(existing)) {
        const c = billingById.get(existing);
        results.push({
          entity_type: "dealer",
          platform_id: d.id,
          platform_name: d.name,
          da_billing_id: existing,
          da_billing_company: c.company ?? c.name ?? "",
          category: "synced",
          match_reason: "existing_id_valid",
        });
      } else {
        results.push({
          entity_type: "dealer",
          platform_id: d.id,
          platform_name: d.name,
          da_billing_id: existing,
          da_billing_company: "",
          category: "mismatch",
          match_reason: "existing_id_not_found_in_billing",
        });
      }
      continue;
    }

    // Not linked — try email first, then name
    const emailKey = norm(d.primary_contact_email);
    const nameKey  = norm(d.name);

    const emailMatches = emailKey ? (dealerEmailIdx.get(emailKey) ?? []) : [];
    const nameMatches  = nameKey  ? (dealerNameIdx.get(nameKey)   ?? []) : [];

    // Prefer email match; use name match only if no email match
    let matches;
    let matchReason;

    if (emailMatches.length > 0) {
      matches = emailMatches;
      matchReason = "email_match";
    } else if (nameMatches.length > 0) {
      matches = nameMatches;
      matchReason = "name_match";
    } else {
      results.push({
        entity_type: "dealer",
        platform_id: d.id,
        platform_name: d.name,
        da_billing_id: "",
        da_billing_company: "",
        category: "genuinely-new",
        match_reason: "no_billing_customer_found",
      });
      continue;
    }

    const unique = [...new Map(matches.map(c => [c.id, c])).values()];

    if (unique.length === 1) {
      results.push({
        entity_type: "dealer",
        platform_id: d.id,
        platform_name: d.name,
        da_billing_id: unique[0].id,
        da_billing_company: unique[0].company ?? unique[0].name ?? "",
        category: "link-missing",
        match_reason: matchReason,
      });
    } else {
      // Compound disambiguation: shared-email clusters (many dealers on one
      // billing email) blow up `unique`, but usually only one of those
      // customers carries this dealer's actual company name. Narrow the
      // email/name candidates to those whose da-billing company equals the
      // dealer name (case-insensitive). Exactly one survivor → safe to link.
      const compound = unique.filter(c => norm(c.company) === nameKey);

      if (compound.length === 1) {
        results.push({
          entity_type: "dealer",
          platform_id: d.id,
          platform_name: d.name,
          da_billing_id: compound[0].id,
          da_billing_company: compound[0].company ?? compound[0].name ?? "",
          category: "link-missing",
          match_reason: `${matchReason}+company_name_match`,
        });
      } else {
        results.push({
          entity_type: "dealer",
          platform_id: d.id,
          platform_name: d.name,
          da_billing_id: unique.map(c => c.id).join("|"),
          da_billing_company: unique.map(c => c.company ?? c.name ?? "").join("|"),
          category: "ambiguous",
          // suffix records why it stayed ambiguous: compound0 = no company-name
          // match in the cluster, compoundN(>1) = still multiple company matches
          match_reason: `${unique.length}_${matchReason}_compound${compound.length}`,
        });
      }
    }
  }

  // ── Tally ──────────────────────────────────────────────────────────────────

  const categories = ["synced", "link-missing", "ambiguous", "genuinely-new", "mismatch"];
  const tally = { group: {}, dealer: {} };
  for (const cat of categories) { tally.group[cat] = 0; tally.dealer[cat] = 0; }
  for (const r of results) tally[r.entity_type][r.category]++;

  console.log("\n=== Summary ===");
  console.log("Groups:");
  for (const cat of categories) console.log(`  ${cat.padEnd(14)}: ${tally.group[cat]}`);
  console.log("Dealers:");
  for (const cat of categories) console.log(`  ${cat.padEnd(14)}: ${tally.dealer[cat]}`);

  const linkMissing = results.filter(r => r.category === "link-missing");
  console.log(`\nLink-missing (would backfill): ${linkMissing.length}`);
  if (linkMissing.length > 0) {
    console.log("  First 20:");
    for (const r of linkMissing.slice(0, 20)) {
      console.log(`    [${r.entity_type}] "${r.platform_name}" → ${r.da_billing_id} (${r.match_reason})`);
    }
    if (linkMissing.length > 20) console.log(`    ... and ${linkMissing.length - 20} more`);
  }

  const ambiguous = results.filter(r => r.category === "ambiguous");
  if (ambiguous.length > 0) {
    console.log(`\nAmbiguous (manual review needed): ${ambiguous.length}`);
    for (const r of ambiguous) {
      console.log(`  [${r.entity_type}] "${r.platform_name}" — matches: ${r.da_billing_id}`);
    }
  }

  // ── Write CSV ──────────────────────────────────────────────────────────────

  const csvPath = resolve(process.cwd(), "billing-links-audit.csv");
  const stream  = createWriteStream(csvPath);
  stream.write(csvRow(["entity_type", "platform_id", "platform_name", "da_billing_id", "da_billing_company", "category", "match_reason"]));
  for (const r of results) {
    stream.write(csvRow([r.entity_type, r.platform_id, r.platform_name, r.da_billing_id, r.da_billing_company, r.category, r.match_reason]));
  }
  await new Promise((res, rej) => stream.end(err => err ? rej(err) : res()));
  console.log(`\nCSV written to: ${csvPath}`);

  // ── Apply writes ───────────────────────────────────────────────────────────

  if (!APPLY) {
    console.log("\n(dry-run — pass --apply to write billing_customer_id)");
    return;
  }

  console.log("\nApplying billing_customer_id updates...");
  let written = 0;
  let errored = 0;

  for (const r of linkMissing) {
    const table = r.entity_type === "group" ? "groups" : "dealers";
    const { error } = await admin
      .from(table)
      .update({ billing_customer_id: r.da_billing_id })
      .eq("id", r.platform_id);

    if (error) {
      console.error(`  ERROR [${r.entity_type}] ${r.platform_name} (${r.platform_id}): ${error.message}`);
      errored++;
    } else {
      process.stdout.write(".");
      written++;
    }
  }
  console.log();
  console.log(`\nDone. Written: ${written}, Errors: ${errored}`);
}

run().catch(err => { console.error("FATAL:", err.message); process.exit(1); });
