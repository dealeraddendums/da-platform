// scripts/resync-group-discounts.mjs
//
// ONE-TIME, idempotent: migrate existing groups' auto subscription discount to
// the NEW tiers. The live sync (lib/sync-group-discount.ts) only fires on a
// dealer add/remove/deactivate, so existing groups keep their OLD discount until
// then — and a group at the OLD 10% would now fail the live AUTO_TIER_VALUES
// guard ({0,20,25,30}) and be frozen as "custom". This backfill fixes both.
//
// NEW tiers (MUST match lib/group-discount.ts calcGroupDiscountTier):
//   1 dealer (or empty) → 0 · 2–10 → 20 · 11–30 → 25 · 31+ → 30
//
// SELECT for change ONLY groups where discountLocked=false AND current
// subscriptionDiscount ∈ {0,10,20,25,30} (old ∪ new auto values). PRESERVE
// everything else: locked groups, and truly-custom values not in that set
// (e.g. 17%). Backs up every considered group to a timestamped JSON, then
// applies, then reports.
//
// Run ON the da-platform box (needs SUPABASE_* + BILLING_API_KEY from env):
//   node --env-file=.env.production scripts/resync-group-discounts.mjs --dry-run
//   node --env-file=.env.production scripts/resync-group-discounts.mjs

import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const DRY = process.argv.includes("--dry-run");
const BASE = "https://billing.dealeraddendums.com/api/v1";
const API_KEY = process.env.BILLING_API_KEY;
const BACKUP_DIR = process.env.RESYNC_BACKUP_DIR || "/var/www/da-platform/shared";

// Old ∪ new auto-tier values. Anything outside this set is operator-custom.
const AUTO_OR_OLD = new Set([0, 10, 20, 25, 30]);

// Keep in lockstep with lib/group-discount.ts.
function calcGroupDiscountTier(n) {
  if (n <= 1) return 0;
  if (n <= 10) return 20;
  if (n <= 30) return 25;
  return 30;
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// da-billing rate-limits bursts (HTTP 429). Retry with exponential backoff so a
// 160-customer sweep doesn't drop requests; also throttled between groups below.
async function fetchRetry(url, opts) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, opts);
    if (res.status !== 429 || attempt >= 6) return res;
    await sleep(750 * Math.pow(2, attempt)); // 0.75,1.5,3,6,12,24s
  }
}

async function getCustomer(customerId) {
  const res = await fetchRetry(`${BASE}/customers/${encodeURIComponent(customerId)}`, {
    headers: { "X-API-Key": API_KEY },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getCustomer ${customerId}: HTTP ${res.status}`);
  const parsed = await res.json();
  return parsed?.customer ?? parsed;
}

async function putDiscount(customerId, value) {
  const res = await fetchRetry(`${BASE}/customers/${encodeURIComponent(customerId)}`, {
    method: "PUT",
    headers: {
      "X-API-Key": API_KEY,
      "Content-Type": "application/json",
      "X-DA-Auto-Tier-Sync": "1",
    },
    body: JSON.stringify({ subscriptionDiscount: value }),
  });
  if (!res.ok) throw new Error(`PUT ${customerId}: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  // Read back so we can confirm da-billing actually accepted the write (its
  // header-guard could silently ignore it if its own auto-tier set disagrees).
  const after = await getCustomer(customerId);
  return Number(after?.subscriptionDiscount ?? NaN);
}

async function activeDealerCount(groupId) {
  const { count, error } = await sb
    .from("dealers")
    .select("id", { count: "exact", head: true })
    .eq("group_id", groupId)
    .eq("active", true);
  if (error) throw new Error(`dealer count ${groupId}: ${error.message}`);
  return count ?? 0;
}

async function fetchAllGroups() {
  const out = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await sb
      .from("groups")
      .select("id, name, billing_customer_id")
      .not("billing_customer_id", "is", null)
      .order("id", { ascending: true })
      .range(from, from + page - 1);
    if (error) throw new Error(`groups fetch: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < page) break;
  }
  return out;
}

(async () => {
  if (!API_KEY) { console.error("BILLING_API_KEY not set — aborting"); process.exit(1); }

  const groups = await fetchAllGroups();
  console.log(`${DRY ? "[DRY-RUN] " : ""}Considering ${groups.length} groups with a billing_customer_id…\n`);

  const records = [];
  for (const g of groups) {
    await sleep(120); // gentle throttle so da-billing doesn't 429 the sweep
    let rec = { groupId: g.id, name: g.name, billing_customer_id: g.billing_customer_id, dealerCount: null, oldDiscount: null, newDiscount: null, action: null };
    try {
      const customer = await getCustomer(g.billing_customer_id);
      if (!customer) { rec.action = "skip-no-customer"; records.push(rec); continue; }

      const locked = customer.discountLocked === true;
      const current = Number(customer.subscriptionDiscount ?? 0);
      const count = await activeDealerCount(g.id);
      const target = calcGroupDiscountTier(count);
      rec.dealerCount = count; rec.oldDiscount = current; rec.newDiscount = target;

      if (locked) { rec.action = "preserve-locked"; rec.newDiscount = current; records.push(rec); continue; }
      if (!AUTO_OR_OLD.has(current)) { rec.action = "preserve-custom"; rec.newDiscount = current; records.push(rec); continue; }
      if (current === target) { rec.action = "unchanged"; records.push(rec); continue; }

      rec.action = `change ${current}→${target}`;
      if (!DRY) {
        const confirmed = await putDiscount(g.billing_customer_id, target);
        rec.confirmed = confirmed;
        if (confirmed !== target) rec.action = `WARN da-billing kept ${confirmed} (write ignored?)`;
      }
      records.push(rec);
    } catch (e) {
      rec.action = `ERROR: ${e.message}`;
      records.push(rec);
    }
  }

  // ── Backup BEFORE reporting (already applied above, but the file is the
  //    authoritative before→after record incl. every considered group) ──────
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${BACKUP_DIR}/resync-group-discounts-${ts}${DRY ? "-DRYRUN" : ""}.json`;
  writeFileSync(backupPath, JSON.stringify({ generatedAt: new Date().toISOString(), dryRun: DRY, tiers: "1→0,2-10→20,11-30→25,31+→30", records }, null, 2));

  // ── Report ────────────────────────────────────────────────────────────────
  const changes = records.filter(r => String(r.action).startsWith("change") || String(r.action).startsWith("WARN"));
  const by = (from, to) => changes.filter(r => r.oldDiscount === from && r.newDiscount === to).length;
  const tally = a => records.filter(r => r.action === a).length;
  console.log("── Changes ──");
  for (const r of changes) console.log(`  ${r.name}  [${r.dealerCount} dealers]  ${r.oldDiscount}% → ${r.newDiscount}%${r.action.startsWith("WARN") ? "  ⚠ " + r.action : ""}`);
  console.log("\n── Totals ──");
  console.log(`  10→20: ${by(10,20)}   10→25: ${by(10,25)}   10→30: ${by(10,30)}`);
  console.log(`  0→20:  ${by(0,20)}    0→25:  ${by(0,25)}    20→25: ${by(20,25)}   20→30: ${by(20,30)}   25→30: ${by(25,30)}`);
  console.log(`  changed: ${changes.length}`);
  console.log(`  unchanged: ${tally("unchanged")}`);
  console.log(`  preserved-locked: ${tally("preserve-locked")}   preserved-custom: ${tally("preserve-custom")}`);
  console.log(`  skip-no-customer: ${tally("skip-no-customer")}   errors: ${records.filter(r => String(r.action).startsWith("ERROR")).length}`);
  console.log(`\nBackup written: ${backupPath}`);
  if (DRY) console.log("\n[DRY-RUN] No writes were made.");
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
