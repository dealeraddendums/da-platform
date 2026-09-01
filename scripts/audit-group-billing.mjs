#!/usr/bin/env node
/**
 * audit-group-billing.mjs — fleet audit of group-billing wiring between
 * DA Platform and da-billing. Read-only; prints a report, changes nothing.
 *
 * Run on the da-platform EC2 (local .env.local has a truncated service key):
 *   cd /var/www/da-platform && node scripts/audit-group-billing.mjs
 *   node scripts/audit-group-billing.mjs --json    # machine-readable
 *
 * Written 2026-09-01 after Chevrolet of Canton was found group-billed in the
 * platform but carrying its subscription on an ORPHAN da-billing template
 * (a template whose customer does not exist). Root cause: StarShield
 * Solutions' groups.billing_customer_id pointed at a phantom customer, so
 * every cascade for that group wrote somewhere nobody bills from.
 *
 * Classes reported:
 *   A  group's billing_customer_id doesn't resolve, or disagrees with where
 *      the group's member lines actually live
 *   B  group-billed dealer whose sub-* line sits somewhere other than the
 *      group's real customer (standalone customer, or an orphan template)
 *   C  group-billed paid-plan dealer with NO sub-* line anywhere (unbilled),
 *      flagging any standalone customer record they still carry
 *   D  a dealer's internal_id on two or more templates (double-bill risk;
 *      ACTIVE-on-ACTIVE is the one that actually bills twice)
 *   E  orphan templates — template exists, customer does not
 */

import { config } from "dotenv";
config({ path: "/var/www/da-platform/.env.production" });

import { createClient } from "@supabase/supabase-js";

const JSON_OUT = process.argv.includes("--json");
const BILLING_KV_URL = process.env.DA_BILLING_SUPABASE_URL;
const BILLING_KV_KEY = process.env.DA_BILLING_SERVICE_ROLE_KEY;
if (!BILLING_KV_URL || !BILLING_KV_KEY) {
  console.error("DA_BILLING_SUPABASE_URL / DA_BILLING_SERVICE_ROLE_KEY are required");
  process.exit(1);
}

const supa = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const billing = createClient(BILLING_KV_URL, BILLING_KV_KEY);

const decode = s => String(s ?? "")
  .replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
const isTest = r => Boolean(r.is_test || r.test_account || (r.account_purpose && r.account_purpose !== "real"));
const NON_BILLING_PLANS = new Set(["free", "trial", "trial expired", "downgraded"]);

/** PostgREST clamps every read at 1000 rows — page everything. */
async function pageAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

const dealers = await pageAll(() => supa.from("dealers")
  .select("id,name,dealer_id,internal_id,group_id,account_type,subscription_billed_to,active,billing_customer_id,is_test,test_account,account_purpose")
  .order("id"));
const groups = await pageAll(() => supa.from("groups")
  .select("id,name,billing_customer_id,billing_id,active,is_test,test_account").order("id"));
const kvRows = await pageAll(() => billing.from("kv_store_0ecc29ad").select("key,value").order("key"));

const customers = new Map();
const templates = new Map();
for (const { key, value } of kvRows) {
  if (key.startsWith("customer:")) customers.set(key.slice(9), value);
  else if (key.startsWith("template:")) templates.set(key.slice(9), value);
}

/** internal_id -> [{ customerId, template, product }] for subscription lines only */
const subLines = new Map();
for (const [customerId, template] of templates) {
  for (const product of template.products ?? []) {
    if (!String(product.productId ?? "").startsWith("sub-")) continue;
    const iid = String(product.lineItemDescription ?? "").split("::")[0].trim();
    if (!iid) continue;
    if (!subLines.has(iid)) subLines.set(iid, []);
    subLines.get(iid).push({ customerId, template, product });
  }
}

const groupById = new Map(groups.map(g => [g.id, g]));
const membersOf = new Map(groups.map(g => [g.id, []]));
for (const d of dealers) {
  if (d.group_id && membersOf.has(d.group_id)) membersOf.get(d.group_id).push(d);
}

/** The customer where a group's member subscription lines actually live. */
const actualCustomer = new Map();
for (const g of groups) {
  const tally = new Map();
  for (const d of membersOf.get(g.id) ?? []) {
    if (d.subscription_billed_to !== "group" || !d.active) continue;
    for (const { customerId } of subLines.get(d.internal_id ?? "") ?? []) {
      tally.set(customerId, (tally.get(customerId) ?? 0) + 1);
    }
  }
  const best = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  actualCustomer.set(g.id, best ? best[0] : null);
}

const label = c => c ? (decode(c.company) || decode(c.name) || "(unnamed)") : "(NO CUSTOMER — orphan template)";
const report = { A: [], B: [], C: [], D: [], E: [] };

for (const g of groups) {
  if (isTest(g) || !g.active) continue;
  const billed = (membersOf.get(g.id) ?? []).filter(d => d.active && !isTest(d) && d.subscription_billed_to === "group");
  if (!billed.length) continue;
  const actual = actualCustomer.get(g.id);
  const bci = g.billing_customer_id;
  const resolves = bci ? customers.has(bci) : null;
  if (bci && !resolves) {
    report.A.push({ group: decode(g.name), groupId: g.id, billing_customer_id: bci, state: "MISSING",
      actual, actualName: label(customers.get(actual)), groupBilledMembers: billed.length });
  } else if (actual && bci !== actual) {
    report.A.push({ group: decode(g.name), groupId: g.id, billing_customer_id: bci, state: bci ? "EXISTS-BUT-WRONG" : "NULL",
      actual, actualName: label(customers.get(actual)), groupBilledMembers: billed.length });
  }
}

for (const d of dealers) {
  if (!d.active || isTest(d) || d.subscription_billed_to !== "group") continue;
  const g = groupById.get(d.group_id);
  if (!g) continue;
  const actual = actualCustomer.get(g.id);
  const lines = subLines.get(d.internal_id ?? "") ?? [];

  for (const { customerId, template, product } of lines) {
    if (customerId === actual) continue;
    const c = customers.get(customerId);
    report.B.push({ dealer: decode(d.name), internal_id: d.internal_id, group: decode(g.name),
      onCustomer: customerId, onCustomerName: label(c), isGroupCustomer: c ? Boolean(c.isGroup) : null,
      orphanTemplate: !c, templateActive: Boolean(template.active),
      productId: product.productId, price: product.price });
  }

  if (!lines.length && !NON_BILLING_PLANS.has(String(d.account_type ?? "").toLowerCase())) {
    let own = d.billing_customer_id && customers.get(d.billing_customer_id) ? d.billing_customer_id : null;
    if (!own) {
      const wanted = decode(d.name).toLowerCase();
      for (const [cid, c] of customers) {
        if (!c.isGroup && decode(c.company).toLowerCase() === wanted) { own = cid; break; }
      }
    }
    const c = own ? customers.get(own) : null;
    report.C.push({ dealer: decode(d.name), internal_id: d.internal_id, group: decode(g.name),
      plan: d.account_type, standaloneCustomer: own,
      standaloneState: c ? { billingState: c.billingState ?? null, archived: Boolean(c.archived) } : null });
  }
}

for (const [iid, lines] of subLines) {
  if (lines.length < 2) continue;
  const d = dealers.find(x => x.internal_id === iid);
  if (d && isTest(d)) continue;
  const active = lines.filter(l => l.template.active);
  report.D.push({ internal_id: iid, dealer: d ? decode(d.name) : "(unknown dealer)",
    templates: lines.length, activeTemplates: active.length, doubleBills: active.length > 1,
    on: lines.map(l => ({ customerId: l.customerId, name: label(customers.get(l.customerId)),
      active: Boolean(l.template.active), productId: l.product.productId, price: l.product.price })) });
}

for (const [customerId, t] of templates) {
  if (customers.has(customerId)) continue;
  report.E.push({ customerId, active: Boolean(t.active), nextInvoiceDate: t.nextInvoiceDate ?? null,
    lastInvoiceDate: t.lastInvoiceDate ?? null,
    lines: (t.products ?? []).map(p => `${p.productId} $${p.price} | ${p.lineItemDescription ?? ""}`) });
}

if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

const head = (k, title) => console.log(`\n${"=".repeat(78)}\n${k}. ${title}  —  ${report[k].length} found\n${"=".repeat(78)}`);

head("A", "groups whose billing_customer_id is wrong (cascades write to the wrong place)");
for (const r of report.A.sort((a, b) => b.groupBilledMembers - a.groupBilledMembers)) {
  console.log(`  ${r.group.padEnd(38)} platform=${r.billing_customer_id ?? "null"} [${r.state}]`);
  console.log(`  ${"".padEnd(38)} actual  =${r.actual} [${r.actualName}]  group-billed members=${r.groupBilledMembers}`);
}

head("B", "group-billed dealers billed OUTSIDE their group's customer");
for (const r of report.B) {
  console.log(`  ${r.dealer.padEnd(34)} grp=${r.group.padEnd(26)} on ${r.onCustomer} [${r.onCustomerName}]`);
  console.log(`  ${"".padEnd(34)} isGroupCustomer=${r.isGroupCustomer} orphanTemplate=${r.orphanTemplate} templateActive=${r.templateActive} ${r.productId} $${r.price}`);
}

head("C", "group-billed paid-plan dealers with NO subscription line anywhere");
for (const r of report.C.sort((a, b) => a.group.localeCompare(b.group))) {
  const s = r.standaloneCustomer
    ? `standalone ${r.standaloneCustomer} (billingState=${r.standaloneState.billingState}, archived=${r.standaloneState.archived})`
    : "no standalone customer";
  console.log(`  ${r.dealer.padEnd(34)} grp=${r.group.padEnd(26)} ${String(r.plan).padEnd(18)} ${s}`);
}

head("D", "dealers on two or more templates (ACTIVE-on-ACTIVE = real double-bill)");
for (const r of report.D.sort((a, b) => Number(b.doubleBills) - Number(a.doubleBills))) {
  console.log(`  ${r.doubleBills ? "!! DOUBLE-BILLS" : "   (safe)"} ${r.internal_id} ${r.dealer} — ${r.templates} templates, ${r.activeTemplates} active`);
  for (const o of r.on) console.log(`        ${o.customerId} [${o.name}] active=${o.active} ${o.productId} $${o.price}`);
}

head("E", "orphan templates (template exists, customer does not)");
for (const r of report.E) {
  console.log(`  ${r.customerId} active=${r.active} next=${r.nextInvoiceDate} last=${r.lastInvoiceDate}`);
  for (const l of r.lines) console.log(`        ${l}`);
}

console.log(`\nSummary: A=${report.A.length} wrong group pointers · B=${report.B.length} mis-routed dealer lines · ` +
  `C=${report.C.length} unbilled group-billed dealers · D=${report.D.filter(r => r.doubleBills).length} real double-bills ` +
  `(${report.D.length} multi-template) · E=${report.E.length} orphan templates\n`);
