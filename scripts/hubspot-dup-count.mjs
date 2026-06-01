#!/usr/bin/env node
/**
 * hubspot-dup-count.mjs — READ-ONLY. Sizes the duplicate-company problem from
 * the HubSpot backfill. Makes NO writes, NO merges, NO deletes — only GETs.
 *
 * Pages every HubSpot company, groups by normalized name, and reports the
 * duplicate clusters. Flags the **sync-created** ones: a record WITH
 * `platformid` (one we created) sitting next to one WITHOUT it (the
 * pre-existing original). Also does a light contact-email dup check (should be
 * ~0 — contacts dedupe on email).
 *
 * Run with prod env (HUBSPOT_PRIVATE_APP_TOKEN), on the box or the local clone:
 *   node scripts/hubspot-dup-count.mjs
 *   node scripts/hubspot-dup-count.mjs --list       # print each sync-dup cluster
 *   node scripts/hubspot-dup-count.mjs --no-contacts # companies only (faster)
 *
 * NOTE: workflow-enrollment counts are NOT included — our private-app token has
 * only crm.objects/crm.schemas scopes, not automation. Check enrollments in the
 * HubSpot UI (Automation → workflow → Enrollment history).
 */

import { readFileSync } from "node:fs";

const LIST = process.argv.includes("--list");
const SKIP_CONTACTS = process.argv.includes("--no-contacts");
const BASE = "https://api.hubapi.com/crm/v3";

// Dependency-free token load: env var first, else parse .env.production. No
// dotenv / node_modules needed, so this runs from any directory on the box.
function loadToken() {
  if (process.env.HUBSPOT_PRIVATE_APP_TOKEN) return process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  for (const p of ["/var/www/da-platform/.env.production", ".env.production"]) {
    try {
      const line = readFileSync(p, "utf8").split(/\r?\n/).find(l => l.startsWith("HUBSPOT_PRIVATE_APP_TOKEN="));
      if (line) return line.slice("HUBSPOT_PRIVATE_APP_TOKEN=".length).trim().replace(/^["']|["']$/g, "");
    } catch { /* not here — try next path */ }
  }
  return null;
}
const TOKEN = loadToken();
if (!TOKEN) { console.error("HUBSPOT_PRIVATE_APP_TOKEN not found (env or /var/www/da-platform/.env.production)"); process.exit(1); }

async function hsGet(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`GET ${path} ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function pageAll(object, properties) {
  const out = [];
  let after;
  do {
    const qs = new URLSearchParams({ limit: "100", properties: properties.join(",") });
    if (after) qs.set("after", after);
    const r = await hsGet(`/objects/${object}?${qs.toString()}`);
    for (const o of r.results ?? []) out.push(o);
    after = r.paging?.next?.after;
    process.stdout.write(`\r  ${object}: ${out.length} fetched…`);
    await new Promise(res => setTimeout(res, 60)); // ~16 req/s, polite
  } while (after);
  process.stdout.write("\n");
  return out;
}

const norm = s => (s ?? "").toString().trim().replace(/\s+/g, " ").toLowerCase();
const has  = v => (v ?? "") !== "";

function analyzeCompanies(companies) {
  const byName = new Map();
  for (const c of companies) {
    const name = norm(c.properties?.name);
    if (!name) continue;
    (byName.get(name) ?? byName.set(name, []).get(name)).push(c);
  }
  let dupClusters = 0, excess = 0, syncCreated = 0, preexisting = 0;
  const samples = [];
  for (const [name, recs] of byName) {
    if (recs.length < 2) continue;
    dupClusters++;
    excess += recs.length - 1;
    const withPid    = recs.filter(r => has(r.properties?.platformid));
    const withoutPid = recs.filter(r => !has(r.properties?.platformid));
    if (withPid.length >= 1 && withoutPid.length >= 1) {
      syncCreated++;
      if (samples.length < 100) samples.push({ name, recs });
    } else {
      preexisting++;
    }
  }
  return { total: companies.length, dupClusters, excess, syncCreated, preexisting, samples };
}

function analyzeContacts(contacts) {
  const byEmail = new Map();
  for (const c of contacts) {
    const email = norm(c.properties?.email);
    if (!email) continue;
    (byEmail.get(email) ?? byEmail.set(email, []).get(email)).push(c);
  }
  let dupEmails = 0, excess = 0;
  for (const [, recs] of byEmail) {
    if (recs.length < 2) continue;
    dupEmails++; excess += recs.length - 1;
  }
  return { total: contacts.length, dupEmails, excess };
}

function fmtRec(r) {
  const p = r.properties ?? {};
  return `id=${r.id} platformid=${has(p.platformid) ? p.platformid : "—"} owner=${has(p.hubspot_owner_id) ? p.hubspot_owner_id : "none"} created=${(p.createdate ?? "").slice(0,10)} phone=${p.phone ?? ""}`;
}

async function run() {
  console.log("HubSpot duplicate count — READ ONLY (no writes)\n");

  const companies = await pageAll("companies", ["name", "platformid", "hubspot_owner_id", "createdate", "phone"]);
  const c = analyzeCompanies(companies);

  console.log("\n=== COMPANIES ===");
  console.log(`  total companies scanned:        ${c.total}`);
  console.log(`  duplicate name-clusters (≥2):   ${c.dupClusters}`);
  console.log(`    • sync-created (platformid + non-platformid together): ${c.syncCreated}`);
  console.log(`    • other/pre-existing dup clusters:                     ${c.preexisting}`);
  console.log(`  excess company records to clean (sum of cluster sizes − clusters): ${c.excess}`);

  if (LIST && c.samples.length) {
    console.log(`\n  --- sync-created dup clusters (first ${c.samples.length}) ---`);
    for (const { name, recs } of c.samples) {
      console.log(`  • "${name}"  (${recs.length})`);
      for (const r of recs) console.log(`      ${fmtRec(r)}`);
    }
  }

  if (!SKIP_CONTACTS) {
    const contacts = await pageAll("contacts", ["email"]);
    const k = analyzeContacts(contacts);
    console.log("\n=== CONTACTS (sanity check — expect ~0) ===");
    console.log(`  total contacts scanned:       ${k.total}`);
    console.log(`  duplicate-email clusters:     ${k.dupEmails}`);
    console.log(`  excess contact records:       ${k.excess}`);
  }

  console.log("\n(Workflow enrollments not counted — token lacks automation scope; check in HubSpot UI.)");
}

run().catch(err => { console.error("\nFATAL:", err.message); process.exit(1); });
