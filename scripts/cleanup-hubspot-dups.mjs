#!/usr/bin/env node
/**
 * cleanup-hubspot-dups.mjs — find and (with --apply) remove the duplicate
 * HubSpot Company records the daily sync / backfill created before the
 * name-dedup fix (commit 498740e).
 *
 * Root cause: full-data sync paths searched for an existing company by
 * platformid (dealers) / groupid (groups). Early-import "original" companies
 * have NO platformid/groupid, so the key search missed them and a NEW company
 * was created WITH the key — producing same-name pairs:
 *     ORIGINAL  older createdate, NO key, has contact associations + history
 *     DUP       recent createdate, HAS key (platformid/groupid)
 *
 * Cleanup strategy (per pair, companies only):
 *   • Keep the ORIGINAL (older, owns the contacts + engagement history).
 *   • HEAL it: PATCH the key (platformid/groupid) onto the original so future
 *     syncs match it by key — this is exactly what the deployed fix now does.
 *   • Repoint Supabase dealers/groups.hubspot_company_id → the original's id.
 *   • ARCHIVE the DUP.
 *
 * Safety:
 *   • Default is DRY-RUN. Pass --apply to actually heal/repoint/archive.
 *   • Only touches companies created in the lookback window (default 36h) that
 *     have a key AND a same-name older sibling that lacks that key.
 *   • Never archives a company that has contact associations the original
 *     doesn't — flagged for manual review instead.
 *   • Window override: --hours=NN. Object filter: --dealers / --groups.
 *
 * Run on the da-platform EC2 (local has a truncated service-role key):
 *   cd /var/www/da-platform/current
 *   node scripts/cleanup-hubspot-dups.mjs              # dry-run, all
 *   node scripts/cleanup-hubspot-dups.mjs --hours=48   # wider window
 *   node scripts/cleanup-hubspot-dups.mjs --apply      # do it
 */

import { config } from "dotenv";
config({ path: "/var/www/da-platform/.env.production" });

import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const HOURS = (() => {
  const a = process.argv.find(x => x.startsWith("--hours="));
  return a ? Number(a.slice("--hours=".length)) : 36;
})();
const FLAGS = process.argv.filter(a => a.startsWith("--") && !a.startsWith("--hours=") && a !== "--apply").map(a => a.slice(2));
const DO_DEALERS = FLAGS.length === 0 || FLAGS.includes("dealers");
const DO_GROUPS  = FLAGS.length === 0 || FLAGS.includes("groups");

const HUBSPOT_BASE = "https://api.hubapi.com/crm/v3";
const TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
if (!TOKEN) { console.error("HUBSPOT_PRIVATE_APP_TOKEN not set"); process.exit(1); }
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const RATE_MS = 60;
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

// All companies created since `sinceMs` (epoch ms), paged. Returns id, name,
// platformid, groupid, createdate.
async function recentCompanies(sinceMs) {
  const out = [];
  let after = undefined;
  for (;;) {
    const body = {
      filterGroups: [{ filters: [{ propertyName: "createdate", operator: "GTE", value: String(sinceMs) }] }],
      properties: ["name", "platformid", "groupid", "createdate"],
      sorts: [{ propertyName: "createdate", direction: "ASCENDING" }],
      limit: 100,
    };
    if (after) body.after = after;
    const r = await hsFetch("POST", `/objects/companies/search`, body);
    out.push(...(r.json?.results ?? []));
    after = r.json?.paging?.next?.after;
    await sleep(RATE_MS);
    if (!after) break;
  }
  return out;
}

// All companies with this exact name (any key state), paged small.
async function companiesByName(name) {
  const r = await hsFetch("POST", `/objects/companies/search`, {
    filterGroups: [{ filters: [{ propertyName: "name", operator: "EQ", value: name }] }],
    properties: ["name", "platformid", "groupid", "createdate"],
    sorts: [{ propertyName: "createdate", direction: "ASCENDING" }],
    limit: 20,
  });
  await sleep(RATE_MS);
  return r.json?.results ?? [];
}

// Count contact associations on a company.
async function contactAssocCount(companyId) {
  const r = await hsFetch("GET", `/objects/companies/${companyId}/associations/contacts?limit=100`);
  return r.json?.results?.length ?? 0;
}

async function main() {
  const sinceMs = Date.now() - HOURS * 60 * 60 * 1000;
  console.log(`\n=== HubSpot duplicate-Company cleanup — ${APPLY ? "APPLY" : "DRY-RUN"} ===`);
  console.log(`Lookback: ${HOURS}h (created since ${new Date(sinceMs).toISOString()})`);
  console.log(`Objects: ${[DO_DEALERS && "dealers", DO_GROUPS && "groups"].filter(Boolean).join(", ")}\n`);

  const recent = await recentCompanies(sinceMs);
  console.log(`Found ${recent.length} companies created in the window.\n`);

  const heal = [];     // { dup, original, kind, dealerRow|groupRow }
  const review = [];    // { dup, reason, ... }
  const noPair = [];    // recent companies with no older same-name sibling (likely legit new)

  for (const c of recent) {
    const p = c.properties || {};
    const name = (p.name || "").trim();
    const hasPlatformId = p.platformid != null && String(p.platformid).trim() !== "";
    const hasGroupId = p.groupid != null && String(p.groupid).trim() !== "";
    if (!name) { review.push({ dup: c, reason: "recent company has NO name (blank record)" }); continue; }

    const kind = hasPlatformId ? "dealer" : hasGroupId ? "group" : null;
    if (kind === "dealer" && !DO_DEALERS) continue;
    if (kind === "group" && !DO_GROUPS) continue;

    // Find same-name siblings created earlier than this one.
    const siblings = await companiesByName(name);
    const older = siblings.filter(s => s.id !== c.id && Number(s.properties.createdate) < Number(p.createdate));
    if (older.length === 0) {
      noPair.push({ dup: c, name });
      continue;
    }

    // Prefer an older sibling that LACKS the matching key (the true orphan original).
    const keyProp = kind === "group" ? "groupid" : "platformid";
    const orphan = older.find(s => {
      const v = s.properties[keyProp];
      return v == null || String(v).trim() === "";
    }) || older[0];

    heal.push({ dup: c, original: orphan, kind: kind || "unknown", name, keyProp,
      keyValue: kind === "group" ? p.groupid : p.platformid });
  }

  // Resolve Supabase rows + association counts for the heal set.
  console.log(`── Pairs to HEAL (keep older original, archive recent dup) ──\n`);
  let n = 0;
  for (const h of heal) {
    n++;
    const dupId = h.dup.id, origId = h.original.id;
    let dupAssoc = "?", origAssoc = "?";
    try { dupAssoc = await contactAssocCount(dupId); } catch {}
    try { origAssoc = await contactAssocCount(origId); } catch {}
    await sleep(RATE_MS);

    // What does Supabase point at?
    let pointer = "(no SB row found)";
    if (h.kind === "dealer") {
      const { data } = await admin.from("dealers").select("id, dealer_id, name, hubspot_company_id").eq("dealer_id", String(h.keyValue)).maybeSingle();
      if (data) pointer = `dealer ${data.dealer_id} SB.hubspot_company_id=${data.hubspot_company_id} (${data.hubspot_company_id === origId ? "ORIGINAL" : data.hubspot_company_id === dupId ? "DUP" : "OTHER"})`;
      h._sb = data;
    } else if (h.kind === "group") {
      const { data } = await admin.from("groups").select("id, name, internal_id, hubspot_company_id").eq("internal_id", String(h.keyValue)).maybeSingle();
      if (data) pointer = `group ${data.internal_id} SB.hubspot_company_id=${data.hubspot_company_id} (${data.hubspot_company_id === origId ? "ORIGINAL" : data.hubspot_company_id === dupId ? "DUP" : "OTHER"})`;
      h._sb = data;
    }

    // Flag for manual review if the dup carries contact associations the original lacks.
    const dupHasMoreContacts = typeof dupAssoc === "number" && typeof origAssoc === "number" && dupAssoc > origAssoc;
    const flag = dupHasMoreContacts ? "  ⚠️ DUP HAS MORE CONTACTS — review before archive" : "";

    console.log(`${n}. "${h.name}" [${h.kind}] key ${h.keyProp}=${h.keyValue}`);
    console.log(`     ORIGINAL keep:    ${origId}  created ${h.original.properties.createdate ? new Date(Number(h.original.properties.createdate)).toISOString() : "?"}  contacts=${origAssoc}  ${h.keyProp}=${h.original.properties[h.keyProp] ?? "(none)"}`);
    console.log(`     DUP archive:      ${dupId}  created ${new Date(Number(h.dup.properties.createdate)).toISOString()}  contacts=${dupAssoc}`);
    console.log(`     Supabase pointer: ${pointer}${flag}`);

    if (dupHasMoreContacts) { review.push({ dup: h.dup, reason: `dup ${dupId} has more contacts (${dupAssoc}) than original ${origId} (${origAssoc})`, name: h.name }); h._skip = true; }
  }

  if (noPair.length) {
    console.log(`\n── No older same-name sibling (left untouched — likely legitimate new records) ──`);
    for (const x of noPair) console.log(`   ${x.dup.id}  "${x.name}"  platformid=${x.dup.properties.platformid ?? "-"} groupid=${x.dup.properties.groupid ?? "-"}`);
  }
  if (review.length) {
    console.log(`\n── Needs MANUAL review (NOT touched) ──`);
    for (const x of review) console.log(`   ${x.dup.id}  ${x.reason}`);
  }

  const actionable = heal.filter(h => !h._skip);
  console.log(`\n=== SUMMARY ===`);
  console.log(`Heal pairs (archive dup, keep+heal original): ${actionable.length}`);
  console.log(`No-pair (untouched):                          ${noPair.length}`);
  console.log(`Manual review (untouched):                    ${review.length}`);

  if (!APPLY) {
    console.log(`\nDRY-RUN — nothing changed. Re-run with --apply to heal originals, repoint Supabase, and archive dups.\n`);
    return;
  }

  console.log(`\n--apply — executing…\n`);
  let healed = 0, repointed = 0, archived = 0, failed = 0;
  for (const h of actionable) {
    try {
      const origId = h.original.id, dupId = h.dup.id;
      // 1. HEAL: copy the dup's full props (incl. the key) onto the original.
      await hsFetch("PATCH", `/objects/companies/${origId}`, { properties: {
        ...h.dup.properties,
        // never overwrite the original's createdate / hs_object_id
        createdate: undefined,
        hs_object_id: undefined,
      }});
      healed++;
      await sleep(RATE_MS);
      // 2. REPOINT Supabase.
      if (h.kind === "dealer" && h._sb && h._sb.hubspot_company_id !== origId) {
        await admin.from("dealers").update({ hubspot_company_id: origId }).eq("id", h._sb.id);
        repointed++;
      } else if (h.kind === "group" && h._sb && h._sb.hubspot_company_id !== origId) {
        await admin.from("groups").update({ hubspot_company_id: origId }).eq("id", h._sb.id);
        repointed++;
      }
      // 3. ARCHIVE the dup.
      await hsFetch("DELETE", `/objects/companies/${dupId}`);
      archived++;
      await sleep(RATE_MS);
      console.log(`   ✓ "${h.name}": healed ${origId}, archived ${dupId}`);
    } catch (e) {
      failed++;
      console.error(`   ✗ "${h.name}": ${e.message}`);
    }
  }
  console.log(`\n=== APPLY DONE === healed=${healed} repointed=${repointed} archived=${archived} failed=${failed}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
