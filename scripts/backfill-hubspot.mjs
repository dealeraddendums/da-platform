#!/usr/bin/env node
/**
 * backfill-hubspot.mjs — one-time HubSpot Company/Contact push for every
 * active dealer, group, and profile. Idempotent: rows that already have
 * a `hubspot_*_id` PATCH the existing record; the rest search by natural
 * key (platformid / groupid / email) and either PATCH a found record or
 * POST a new one, writing the returned id back to Supabase.
 *
 * Run on the da-platform EC2 — local copies have a truncated
 * SUPABASE_SERVICE_ROLE_KEY (see memory/project_env_local_truncated_key).
 *
 *   ssh -i ~/ssh/DA_Platform_2026.pem ubuntu@<jump-host>
 *   cd /var/www/da-platform
 *   node scripts/backfill-hubspot.mjs --dry-run        # preview only
 *   node scripts/backfill-hubspot.mjs --dealers        # dealers only
 *   node scripts/backfill-hubspot.mjs --groups         # groups only
 *   node scripts/backfill-hubspot.mjs --profiles       # contacts only
 *   node scripts/backfill-hubspot.mjs                  # all three (default)
 *
 * Pacing: spaces requests ~50ms apart (~20 req/s) so a ~1.6k-dealer
 * backfill stays comfortably under HubSpot's 100 req/10s burst limit.
 */

import { config } from "dotenv";
config({ path: "/var/www/da-platform/.env.production" });

import { createClient } from "@supabase/supabase-js";

const DRY_RUN = process.argv.includes("--dry-run");
const FLAGS   = process.argv.filter(a => a.startsWith("--") && a !== "--dry-run").map(a => a.slice(2));
const RUN_DEALERS  = FLAGS.length === 0 || FLAGS.includes("dealers");
const RUN_GROUPS   = FLAGS.length === 0 || FLAGS.includes("groups");
const RUN_PROFILES = FLAGS.length === 0 || FLAGS.includes("profiles");
const RATE_MS = 50;

const HUBSPOT_BASE = "https://api.hubapi.com/crm/v3";
const TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
if (!TOKEN) { console.error("HUBSPOT_PRIVATE_APP_TOKEN not set"); process.exit(1); }

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

/**
 * Walk an entire table in 1000-row chunks. Supabase JS / PostgREST caps
 * any single .select() at 1000 rows by default — without pagination the
 * backfill silently skipped half the data set on first run.
 */
async function fetchAll(table, selectCols, eqFilters = []) {
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = admin.from(table).select(selectCols).range(from, from + PAGE - 1);
    for (const [col, val] of eqFilters) q = q.eq(col, val);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

// ── Reuse the same property builders + idempotent upsert as lib/sync-hubspot.ts ──
// Re-implemented inline to keep the script self-contained (no @-import of TS).

const LIFECYCLE = {
  CUSTOMER:           "customer",
  DEALER_TRIAL:       "60435067",
  GROUP_TRIAL:        "60429213",
  TRIAL_EXPIRED:      "65495635",
};

const SUBSCRIPTION_TYPE_MAP = {
  "Manual":          "Manual",
  "Automatic Web":   "Auto-Web",
  "Automatic DMS":   "Auto-DMS",
  "Free":            "Free",
  "Trial":           "Trial",
  "PAYGo":           "PAYGo",
  "sub-manual":      "Manual",
  "sub-auto-web":    "Auto-Web",
  "sub-auto-dms":    "Auto-DMS",
};

function normalizeSubscriptionType(at) {
  if (!at) return null;
  const trimmed = at.split(" $")[0].trim();
  return SUBSCRIPTION_TYPE_MAP[trimmed] ?? null;
}
function isPayingAccount(at) {
  const n = normalizeSubscriptionType(at);
  return n != null && n !== "Free" && n !== "Trial";
}
function digitsOnly(s) {
  if (!s) return null;
  const d = String(s).replace(/\D+/g, "");
  return d ? Number(d) : null;
}

async function hsFetch(method, path, body) {
  const res = await fetch(`${HUBSPOT_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => "");
  if (!res.ok && res.status !== 409) throw new Error(`${method} ${path} ${res.status}: ${text.slice(0, 300)}`);
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function searchByProperty(object, propertyName, value) {
  const r = await hsFetch("POST", `/objects/${object}/search`, {
    filterGroups: [{ filters: [{ propertyName, operator: "EQ", value }] }],
    limit: 1,
  });
  return r.json?.results?.[0] ?? null;
}

async function upsert({ object, properties, existingId, searchProperty, searchValue }) {
  const clean = {};
  for (const [k, v] of Object.entries(properties)) {
    if (v === null || v === undefined || v === "") continue;
    clean[k] = v;
  }
  if (existingId) {
    const r = await hsFetch("PATCH", `/objects/${object}/${encodeURIComponent(existingId)}`, { properties: clean });
    return { hubspotId: r.json.id, created: false };
  }
  if (searchValue) {
    const found = await searchByProperty(object, searchProperty, searchValue);
    if (found) {
      const r = await hsFetch("PATCH", `/objects/${object}/${encodeURIComponent(found.id)}`, { properties: clean });
      return { hubspotId: r.json.id, created: true };
    }
  }
  const r = await hsFetch("POST", `/objects/${object}`, { properties: clean });
  if (r.status === 409) {
    const m = (r.json && JSON.stringify(r.json)).match(/Existing ID:\s*(\d+)/i);
    if (m) {
      const upd = await hsFetch("PATCH", `/objects/${object}/${m[1]}`, { properties: clean });
      return { hubspotId: upd.json.id, created: true };
    }
    throw new Error(`409 from POST ${object} with no existing id`);
  }
  return { hubspotId: r.json.id, created: true };
}

function dealerProps(d, groupName, groupInternalId) {
  const platformId = d.dealer_id;
  return {
    name: d.name,
    dealerid: d.inventory_dealer_id != null ? String(d.inventory_dealer_id) : null,
    platformid: platformId,
    da_dealer_: platformId,
    billingid: d.billing_customer_id ?? d.internal_id ?? null,
    groupid: groupInternalId,
    dealer_group: groupName,
    address: d.address, city: d.city, state: d.state, zip: d.zip, country: d.country,
    phone: d.phone,
    dealership_phone: digitsOnly(d.phone),
    company_email: d.primary_contact_email,
    subscription_type: normalizeSubscriptionType(d.account_type),
    sub_billing_to: d.sub_billing_to,
    billing_contact_mailing_address: d.billing_street,
    billing_contact_city:            d.billing_city,
    billing_contact_state:           d.billing_state,
    billing_contact_zip:             d.billing_zip,
    billing_contact_name:            d.billing_to ?? d.primary_contact,
    billing_contact_email:           d.primary_contact_email,
    billing_contact_phone_number:    d.phone,
    feed_company:      d.inventory_provider,
    feed_company_type: d.inventory_provider ? (d.inventory_provider_is_dms ? "Auto-DMS" : "Auto-Web") : null,
    prints_last_30: d.last30 ?? 0,
    lifecyclestage: isPayingAccount(d.account_type) ? LIFECYCLE.CUSTOMER : LIFECYCLE.DEALER_TRIAL,
  };
}

function groupProps(g, memberCount) {
  return {
    name: g.name,
    groupid: g.internal_id,
    billingid: g.billing_customer_id ?? null,
    dealers_in_group: memberCount,
    lifecyclestage: g.hubspot_company_id ? null : LIFECYCLE.GROUP_TRIAL,
  };
}

function profileProps(p, companyName) {
  const [firstname, ...rest] = (p.full_name ?? "").trim().split(/\s+/);
  return {
    email: p.email,
    firstname: firstname || null,
    lastname:  rest.join(" ") || null,
    phone: p.phone,
    user_type: p.role,
    username: p.email,
    user_id: p.email,
    dealer_id: p.dealer_id,
    group_id: p.group_id,
    company: companyName,
  };
}

async function run() {
  console.log(`HubSpot backfill — ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}`);
  console.log(`  scopes: ${[RUN_DEALERS&&"dealers", RUN_GROUPS&&"groups", RUN_PROFILES&&"profiles"].filter(Boolean).join(", ")}`);
  const stats = { dealers: { ok: 0, err: 0 }, groups: { ok: 0, err: 0 }, profiles: { ok: 0, err: 0 } };

  if (RUN_DEALERS) {
    const dealers = await fetchAll("dealers",
      "id, dealer_id, name, address, city, state, zip, country, phone, primary_contact, primary_contact_email, inventory_dealer_id, billing_customer_id, internal_id, group_id, account_type, sub_billing_to, inventory_provider, inventory_provider_is_dms, last30, billing_street, billing_city, billing_state, billing_zip, billing_to, hubspot_company_id, created_at",
      [["active", true]],
    );
    console.log(`\nDealers to process: ${dealers.length}`);
    // Preload groups once
    const allGroups = await fetchAll("groups", "id, name, internal_id");
    const groupById = new Map(allGroups.map(g => [g.id, g]));

    for (const d of dealers) {
      try {
        const g = d.group_id ? groupById.get(d.group_id) : null;
        const props = dealerProps(d, g?.name ?? null, g?.internal_id ?? null);
        if (DRY_RUN) {
          console.log(`  [dry] ${d.dealer_id}  hubspot_company_id=${d.hubspot_company_id || "(none)"}  → would ${d.hubspot_company_id ? "PATCH" : "SEARCH/CREATE"} with ${Object.values(props).filter(v => v != null && v !== "").length} non-null props`);
        } else {
          const { hubspotId, created } = await upsert({
            object: "companies", properties: props,
            existingId: d.hubspot_company_id,
            searchProperty: "platformid", searchValue: d.dealer_id,
          });
          if (created || hubspotId !== d.hubspot_company_id) {
            await admin.from("dealers").update({ hubspot_company_id: hubspotId }).eq("id", d.id);
          }
          process.stdout.write(created ? "+" : ".");
          await new Promise(r => setTimeout(r, RATE_MS));
        }
        stats.dealers.ok++;
      } catch (err) {
        stats.dealers.err++;
        console.error(`\n  ❌ ${d.dealer_id}: ${err.message}`);
      }
    }
    if (!DRY_RUN) console.log();
  }

  if (RUN_GROUPS) {
    const groups = await fetchAll("groups", "id, name, internal_id, hubspot_company_id, billing_customer_id");
    console.log(`\nGroups to process: ${groups.length}`);
    for (const g of groups) {
      try {
        const { count: memberCount } = await admin.from("dealers").select("id", { count: "exact", head: true }).eq("group_id", g.id).eq("active", true);
        const props = groupProps(g, memberCount ?? 0);
        if (DRY_RUN) {
          console.log(`  [dry] ${g.name}  (${memberCount} members)  hubspot=${g.hubspot_company_id || "(none)"}`);
        } else {
          const { hubspotId, created } = await upsert({
            object: "companies", properties: props,
            existingId: g.hubspot_company_id,
            searchProperty: "groupid", searchValue: g.internal_id,
          });
          if (created || hubspotId !== g.hubspot_company_id) {
            await admin.from("groups").update({ hubspot_company_id: hubspotId }).eq("id", g.id);
          }
          process.stdout.write(created ? "+" : ".");
          await new Promise(r => setTimeout(r, RATE_MS));
        }
        stats.groups.ok++;
      } catch (err) {
        stats.groups.err++;
        console.error(`\n  ❌ group ${g.id}: ${err.message}`);
      }
    }
    if (!DRY_RUN) console.log();
  }

  if (RUN_PROFILES) {
    const profiles = await fetchAll("profiles",
      "id, email, full_name, phone, role, dealer_id, group_id, hubspot_contact_id, active",
      [["active", true]],
    );
    console.log(`\nProfiles to process: ${profiles.length}`);
    // Preload dealers for company-name lookup
    const allDealers = await fetchAll("dealers", "dealer_id, name");
    const dealerNameBySlug = new Map(allDealers.map(d => [d.dealer_id, d.name]));

    for (const p of profiles) {
      try {
        const companyName = p.dealer_id ? dealerNameBySlug.get(p.dealer_id) ?? null : null;
        const props = profileProps(p, companyName);
        if (DRY_RUN) {
          console.log(`  [dry] ${p.email}  hubspot=${p.hubspot_contact_id || "(none)"}`);
        } else {
          const { hubspotId, created } = await upsert({
            object: "contacts", properties: props,
            existingId: p.hubspot_contact_id,
            searchProperty: "email", searchValue: p.email,
          });
          if (created || hubspotId !== p.hubspot_contact_id) {
            await admin.from("profiles").update({ hubspot_contact_id: hubspotId }).eq("id", p.id);
          }
          process.stdout.write(created ? "+" : ".");
          await new Promise(r => setTimeout(r, RATE_MS));
        }
        stats.profiles.ok++;
      } catch (err) {
        stats.profiles.err++;
        console.error(`\n  ❌ ${p.email}: ${err.message}`);
      }
    }
    if (!DRY_RUN) console.log();
  }

  console.log("\n=== Summary ===");
  console.log(`  Dealers:  ${stats.dealers.ok} ok, ${stats.dealers.err} err`);
  console.log(`  Groups:   ${stats.groups.ok} ok, ${stats.groups.err} err`);
  console.log(`  Profiles: ${stats.profiles.ok} ok, ${stats.profiles.err} err`);
  if (DRY_RUN) console.log("\n(dry-run — no writes performed)");
}

run().catch(err => { console.error("FATAL:", err.message); process.exit(1); });
