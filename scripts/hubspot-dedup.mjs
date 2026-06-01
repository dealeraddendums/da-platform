#!/usr/bin/env node
/**
 * hubspot-dedup.mjs — one-time merge of HubSpot Company duplicates
 * created by the 2026-05-30 backfill.
 *
 * Symptom: the backfill matches by `platformid` (dealers) / `groupid`
 * (groups). Pre-existing records that lacked that key were missed,
 * a bare "no owner" duplicate was created, and the new id was written
 * back to the Supabase row — orphaning the real record (owner, logo,
 * activity, associations).
 *
 * Fix per dealer / group:
 *   1. Identify OUR record (the one with platformid/groupid).
 *   2. Find the unlinked original — a Company with the same name + phone
 *      that lacks our own-key.
 *   3. MERGE: POST /crm/v3/objects/companies/merge with
 *      { primaryObjectId: original, objectIdToMerge: ourDup }.
 *      Survivor = the original (keeps id, owner, activity).
 *   4. Re-point Supabase: `hubspot_company_id = original.id`.
 *   5. Re-stamp: PATCH the survivor with the full dealer/group props
 *      so platformid/groupid + the four IDs land on the now-correct
 *      record. Future syncs match by own-key without needing this script.
 *
 * Usage (run on the box — local has a truncated service-role key):
 *   ssh -i ~/ssh/DA_Platform_2026.pem ubuntu@<da-platform>
 *   cd /var/www/da-platform
 *   node scripts/hubspot-dedup.mjs                    # dry-run (default), both scopes
 *   node scripts/hubspot-dedup.mjs --dealers          # dry-run, dealers only
 *   node scripts/hubspot-dedup.mjs --groups           # dry-run, groups only
 *   node scripts/hubspot-dedup.mjs --apply            # ⚠️ irreversible — merges + restamps
 *
 * Dry-run prints every decision (MERGE / SKIP / REVIEW) and totals.
 * REVIEW = ambiguous (multiple unlinked candidates, or no phone match)
 * — handle these by hand in HubSpot's Manage Duplicates UI.
 *
 * Pre-flight: ask Alex to pause any HubSpot workflows that enroll on
 * `lifecyclestage` / `subscription_type` before --apply. The merges
 * themselves are inert from a workflow standpoint (they consolidate
 * enrollments), but the post-merge re-stamp can re-fire property-change
 * triggers on the surviving record.
 */

import { config } from "dotenv";
config({ path: "/var/www/da-platform/.env.production" });

import { createClient } from "@supabase/supabase-js";

// ── CLI flags ──────────────────────────────────────────────────────────────
const APPLY        = process.argv.includes("--apply");
const ONLY_DEALERS = process.argv.includes("--dealers");
const ONLY_GROUPS  = process.argv.includes("--groups");
const RUN_DEALERS  = !ONLY_GROUPS;   // both → both true
const RUN_GROUPS   = !ONLY_DEALERS;
const RATE_MS = 50;                  // ~20 req/s — same as backfill

// ── HubSpot client ─────────────────────────────────────────────────────────
const HUBSPOT_BASE = "https://api.hubapi.com/crm/v3";
const TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
if (!TOKEN) { console.error("HUBSPOT_PRIVATE_APP_TOKEN not set"); process.exit(1); }

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

async function pageAllCompanies() {
  const out = [];
  let after;
  do {
    const qs = new URLSearchParams({
      limit: "100",
      properties: ["name", "phone", "platformid", "groupid", "hubspot_owner_id", "createdate"].join(","),
    });
    if (after) qs.set("after", after);
    const { json } = await hsFetch("GET", `/objects/companies?${qs.toString()}`);
    for (const o of json?.results ?? []) out.push(o);
    after = json?.paging?.next?.after;
    process.stdout.write(`\r  companies fetched: ${out.length}…`);
    await new Promise(r => setTimeout(r, 60));
  } while (after);
  process.stdout.write("\n");
  return out;
}

// ── Supabase client ────────────────────────────────────────────────────────
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

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

// ── Property builders (mirror lib/sync-hubspot.ts) ─────────────────────────
const LIFECYCLE = {
  CUSTOMER:           "customer",
  DEALER_TRIAL:       "60435067",
  GROUP_TRIAL:        "60429213",
  TRIAL_EXPIRED:      "65495635",
  ACCOUNT_DOWNGRADED: "108387744",
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
  return d || null;
}

function dealerProps(d, groupName, groupInternalId) {
  return {
    name: d.name,
    dealerid: d.inventory_dealer_id != null ? String(d.inventory_dealer_id) : null,
    platformid: d.dealer_id,
    da_dealer_: d.dealer_id,
    billingid: d.billing_customer_id ?? d.internal_id ?? null,
    groupid: groupInternalId,
    dealer_group: groupName,
    address: d.address, city: d.city, state: d.state, zip: d.zip, country: d.country,
    phone: d.phone,
    dealership_phone: digitsOnly(d.phone) ? Number(digitsOnly(d.phone)) : null,
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
    lifecyclestage:
      isPayingAccount(d.account_type) ? LIFECYCLE.CUSTOMER
      : d.downgraded_at              ? LIFECYCLE.ACCOUNT_DOWNGRADED
      :                                LIFECYCLE.DEALER_TRIAL,
  };
}

function groupProps(g, memberCount) {
  return {
    name: g.name,
    groupid: g.internal_id,
    billingid: g.billing_customer_id ?? null,
    dealers_in_group: memberCount,
    // groups: never push lifecyclestage on existing records — the
    // operator's HubSpot edit wins. Survivor already has whatever
    // stage the operator set.
  };
}

// ── Pair-matching helpers ─────────────────────────────────────────────────
const norm = s => (s ?? "").toString().trim().replace(/\s+/g, " ").toLowerCase();
const has  = v => (v ?? "") !== "";

/**
 * Find the unlinked-original candidate for `ourRec`.
 *   - Same normalized name.
 *   - Different HubSpot id.
 *   - Does NOT carry `ownKey` (platformid for dealers, groupid for groups).
 *   - Phone digits-only match against `subjectPhone` raises confidence.
 *
 * Returns one of:
 *   { kind: "merge", original }                 — exactly one confident match
 *   { kind: "review", candidates }              — multiple, or no phone confidence
 *   { kind: "skip" }                             — no candidates (legit single record)
 */
function findOriginal({ subjectName, subjectPhone, ourRec, ownKey, byName }) {
  const cluster = byName.get(norm(subjectName)) ?? [];
  const candidates = cluster.filter(c => c.id !== ourRec.id && !has(c.properties?.[ownKey]));
  if (candidates.length === 0) return { kind: "skip" };
  const subjectDigits = digitsOnly(subjectPhone);
  const confident = subjectDigits
    ? candidates.filter(c => digitsOnly(c.properties?.phone) === subjectDigits)
    : [];
  if (confident.length === 1) return { kind: "merge", original: confident[0] };
  return { kind: "review", candidates };
}

// ── Action: merge + repoint + restamp ─────────────────────────────────────
async function mergeAndRestamp({ primary, secondary, props, supabaseTable, supabaseId }) {
  // 1. Merge — primary survives, secondary retired.
  await hsFetch("POST", `/objects/companies/merge`, {
    primaryObjectId: primary.id,
    objectIdToMerge: secondary.id,
  });
  await new Promise(r => setTimeout(r, RATE_MS));

  // 2. Re-point Supabase row to the survivor.
  const { error: uErr } = await admin
    .from(supabaseTable)
    .update({ hubspot_company_id: primary.id })
    .eq("id", supabaseId);
  if (uErr) throw new Error(`supabase update ${supabaseTable}: ${uErr.message}`);

  // 3. Re-stamp — PATCH the survivor with the full DA payload so
  //    platformid / groupid / the four IDs / subscription_type /
  //    lifecyclestage all land on the right record.
  const clean = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === "") continue;
    clean[k] = v;
  }
  await hsFetch("PATCH", `/objects/companies/${encodeURIComponent(primary.id)}`, { properties: clean });
  await new Promise(r => setTimeout(r, RATE_MS));
}

// ── Output formatting ─────────────────────────────────────────────────────
function fmtRec(r) {
  const p = r.properties ?? {};
  return `${r.id} owner=${has(p.hubspot_owner_id) ? p.hubspot_owner_id : "-"} created=${(p.createdate ?? "").slice(0,10)} phone=${p.phone ?? ""} platformid=${has(p.platformid) ? p.platformid : "-"} groupid=${has(p.groupid) ? p.groupid : "-"}`;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function run() {
  console.log(`HubSpot dedup — ${APPLY ? "🔴 LIVE (--apply)" : "DRY RUN (no writes)"}`);
  console.log(`  scopes: ${[RUN_DEALERS && "dealers", RUN_GROUPS && "groups"].filter(Boolean).join(", ")}`);

  // Page all companies once → build indices.
  console.log("\nFetching all HubSpot companies…");
  const companies = await pageAllCompanies();
  const byId = new Map(companies.map(c => [c.id, c]));
  const byPlatformid = new Map();
  const byGroupid = new Map();
  const byName = new Map();
  for (const c of companies) {
    const p = c.properties ?? {};
    if (has(p.platformid)) byPlatformid.set(p.platformid, c);
    if (has(p.groupid))    byGroupid.set(p.groupid, c);
    const n = norm(p.name);
    if (!n) continue;
    (byName.get(n) ?? byName.set(n, []).get(n)).push(c);
  }
  console.log(`  indexed: ${companies.length} companies · ${byPlatformid.size} with platformid · ${byGroupid.size} with groupid`);

  const totals = {
    dealers: { merge: 0, skip: 0, review: 0, missing_our_rec: 0, errors: 0 },
    groups:  { merge: 0, skip: 0, review: 0, missing_our_rec: 0, errors: 0 },
  };
  const reviewList = [];

  // ── Dealers ──────────────────────────────────────────────────────────────
  if (RUN_DEALERS) {
    const dealers = await fetchAll("dealers",
      "id, dealer_id, name, address, city, state, zip, country, phone, primary_contact, primary_contact_email, inventory_dealer_id, billing_customer_id, internal_id, group_id, account_type, sub_billing_to, inventory_provider, inventory_provider_is_dms, last30, billing_street, billing_city, billing_state, billing_zip, billing_to, hubspot_company_id, created_at, downgraded_at",
      [["active", true]],
    );
    const allGroups = await fetchAll("groups", "id, name, internal_id");
    const groupById = new Map(allGroups.map(g => [g.id, g]));
    console.log(`\n=== Dealers (${dealers.length} active) ===`);

    for (const d of dealers) {
      const ourRec = (d.hubspot_company_id && byId.get(d.hubspot_company_id)) || byPlatformid.get(d.dealer_id) || null;
      if (!ourRec) {
        totals.dealers.missing_our_rec++;
        continue;
      }
      const decision = findOriginal({
        subjectName: d.name,
        subjectPhone: d.phone,
        ourRec,
        ownKey: "platformid",
        byName,
      });

      if (decision.kind === "skip") {
        totals.dealers.skip++;
        continue;
      }
      if (decision.kind === "review") {
        totals.dealers.review++;
        reviewList.push({ kind: "dealer", id: d.dealer_id, name: d.name, ourRec, candidates: decision.candidates });
        console.log(`  REVIEW  ${d.dealer_id}  "${d.name}"`);
        console.log(`             ours: ${fmtRec(ourRec)}`);
        for (const c of decision.candidates) console.log(`             cand: ${fmtRec(c)}`);
        continue;
      }

      const original = decision.original;
      totals.dealers.merge++;
      console.log(`  MERGE   ${d.dealer_id}  "${d.name}"  primary=${original.id} secondary=${ourRec.id}  owner=${original.properties?.hubspot_owner_id || "-"}`);

      if (APPLY) {
        try {
          const g = d.group_id ? groupById.get(d.group_id) : null;
          const props = dealerProps(d, g?.name ?? null, g?.internal_id ?? null);
          await mergeAndRestamp({ primary: original, secondary: ourRec, props, supabaseTable: "dealers", supabaseId: d.id });
          process.stdout.write(".");
        } catch (err) {
          totals.dealers.errors++;
          console.error(`\n    ❌ ${d.dealer_id}: ${err.message}`);
        }
      }
    }
    if (APPLY) console.log();
  }

  // ── Groups ───────────────────────────────────────────────────────────────
  if (RUN_GROUPS) {
    const groups = await fetchAll("groups", "id, name, internal_id, billing_customer_id, hubspot_company_id, phone");
    console.log(`\n=== Groups (${groups.length}) ===`);

    for (const g of groups) {
      const ourRec = (g.hubspot_company_id && byId.get(g.hubspot_company_id)) || byGroupid.get(g.internal_id) || null;
      if (!ourRec) {
        totals.groups.missing_our_rec++;
        continue;
      }
      const decision = findOriginal({
        subjectName: g.name,
        subjectPhone: g.phone,
        ourRec,
        ownKey: "groupid",
        byName,
      });

      if (decision.kind === "skip") {
        totals.groups.skip++;
        continue;
      }
      if (decision.kind === "review") {
        totals.groups.review++;
        reviewList.push({ kind: "group", id: g.internal_id, name: g.name, ourRec, candidates: decision.candidates });
        console.log(`  REVIEW  group ${g.internal_id}  "${g.name}"`);
        console.log(`             ours: ${fmtRec(ourRec)}`);
        for (const c of decision.candidates) console.log(`             cand: ${fmtRec(c)}`);
        continue;
      }

      const original = decision.original;
      totals.groups.merge++;
      console.log(`  MERGE   group ${g.internal_id}  "${g.name}"  primary=${original.id} secondary=${ourRec.id}  owner=${original.properties?.hubspot_owner_id || "-"}`);

      if (APPLY) {
        try {
          const { count: memberCount } = await admin.from("dealers").select("id", { count: "exact", head: true }).eq("group_id", g.id).eq("active", true);
          const props = groupProps(g, memberCount ?? 0);
          await mergeAndRestamp({ primary: original, secondary: ourRec, props, supabaseTable: "groups", supabaseId: g.id });
          process.stdout.write(".");
        } catch (err) {
          totals.groups.errors++;
          console.error(`\n    ❌ group ${g.internal_id}: ${err.message}`);
        }
      }
    }
    if (APPLY) console.log();
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\n=== Summary ===");
  if (RUN_DEALERS) console.log(`  Dealers — MERGE: ${totals.dealers.merge}  REVIEW: ${totals.dealers.review}  SKIP (clean): ${totals.dealers.skip}  no-our-record: ${totals.dealers.missing_our_rec}  errors: ${totals.dealers.errors}`);
  if (RUN_GROUPS)  console.log(`  Groups  — MERGE: ${totals.groups.merge}  REVIEW: ${totals.groups.review}  SKIP (clean): ${totals.groups.skip}  no-our-record: ${totals.groups.missing_our_rec}  errors: ${totals.groups.errors}`);
  const totalMerges  = totals.dealers.merge  + totals.groups.merge;
  const totalReviews = totals.dealers.review + totals.groups.review;
  console.log(`  TOTAL would-merge: ${totalMerges}    needs-manual-review: ${totalReviews}`);
  if (!APPLY) {
    console.log("\n(dry-run — no writes performed. Spot-check 5–10 MERGE lines against HubSpot before re-running with --apply.)");
  } else {
    console.log("\n✅ Apply complete. Verify a few survivors in HubSpot have platformid/groupid stamped + the dealer-page link opens the right record.");
  }
}

run().catch(err => { console.error("\nFATAL:", err.message); process.exit(1); });
