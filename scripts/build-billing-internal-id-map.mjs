#!/usr/bin/env node
/**
 * Build the customerId → internal_id map that da-billing's
 * scripts/backfill-customer-internal-id.mjs consumes.
 *
 * da-billing resolves the group-billed "G" from the `{internal_id}::{name}`
 * line descriptions on group templates. Historically it matched the NAME half
 * against customer.company, which drifts on rename. The fix matches the ID
 * half against a new `customer.internalId` — and nothing has ever written that
 * field, so it has to be seeded from the platform, which owns the linkage.
 *
 * The linkage used is the EXPLICIT one: dealers.billing_customer_id /
 * groups.billing_customer_id. Anything ambiguous is skipped and reported
 * rather than guessed — a wrong internalId would mis-badge, and a skipped one
 * simply keeps today's name-based behaviour.
 *
 *   node scripts/build-billing-internal-id-map.mjs > /tmp/internal-id-map.json
 *
 * Needs SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY.
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}
const sb = createClient(url, key);

/** PostgREST clamps every request to 1000 rows — page or silently truncate. */
async function readAll(table, columns) {
  const rows = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await sb.from(table).select(columns).range(from, from + size - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < size) return rows;
  }
}

const dealers = await readAll("dealers", "id,name,internal_id,billing_customer_id");
const groups = await readAll("groups", "id,name,internal_id,billing_customer_id");

const dealersByCustomer = new Map();
for (const d of dealers) {
  if (!d.billing_customer_id) continue;
  if (!dealersByCustomer.has(d.billing_customer_id)) dealersByCustomer.set(d.billing_customer_id, []);
  dealersByCustomer.get(d.billing_customer_id).push(d);
}
const groupsByCustomer = new Map();
for (const g of groups) {
  if (!g.billing_customer_id) continue;
  if (!groupsByCustomer.has(g.billing_customer_id)) groupsByCustomer.set(g.billing_customer_id, []);
  groupsByCustomer.get(g.billing_customer_id).push(g);
}

const entries = [];
const skipped = [];

for (const [customerId, ds] of dealersByCustomer) {
  // More than one dealer pointing at one customer means the platform link is
  // itself ambiguous — stamping either dealer's id could badge the wrong
  // group. Report it; name resolution continues to apply.
  if (ds.length > 1) {
    skipped.push({ customerId, reason: "multiple dealers share this billing_customer_id", detail: ds.map((d) => `${d.name} [${d.internal_id}]`) });
    continue;
  }
  if (groupsByCustomer.has(customerId)) {
    skipped.push({ customerId, reason: "claimed by both a dealer and a group", detail: [ds[0].name, ...groupsByCustomer.get(customerId).map((g) => g.name)] });
    continue;
  }
  if (!ds[0].internal_id) {
    skipped.push({ customerId, reason: "dealer has no internal_id", detail: [ds[0].name] });
    continue;
  }
  entries.push({ customerId, internalId: String(ds[0].internal_id).trim(), source: "dealer", sourceName: ds[0].name });
}

for (const [customerId, gs] of groupsByCustomer) {
  if (dealersByCustomer.has(customerId)) continue; // already reported above
  if (gs.length > 1) {
    skipped.push({ customerId, reason: "multiple groups share this billing_customer_id", detail: gs.map((g) => `${g.name} [${g.internal_id}]`) });
    continue;
  }
  if (!gs[0].internal_id) {
    skipped.push({ customerId, reason: "group has no internal_id", detail: [gs[0].name] });
    continue;
  }
  entries.push({ customerId, internalId: String(gs[0].internal_id).trim(), source: "group", sourceName: gs[0].name });
}

console.error(`dealers ${dealers.length} · groups ${groups.length} → ${entries.length} mappings, ${skipped.length} skipped`);
process.stdout.write(JSON.stringify({ builtAt: new Date().toISOString(), entries, skipped }, null, 2));
