/**
 * Backfill platform billing_customer_id from the already-present billing_id
 * (which holds the da-billing customer UUID). docs/platform-billing-link-sync.md
 * step 2. The audit proved billing_id → da-billing customer.id is exact (76.1%,
 * collisions flagged). This ONLY copies billing_id → billing_customer_id for the
 * clean link-missing set; it never overwrites an existing link, never touches
 * collisions, never creates anything.
 *
 *   npx tsx scripts/billing-link-backfill.ts            # DRY-RUN (default, read-only)
 *   npx tsx scripts/billing-link-backfill.ts --write     # apply
 *
 * Idempotent: the UPDATE is guarded by `billing_customer_id IS NULL`, so a second
 * run changes nothing.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const WRITE = process.argv.includes("--write");

for (const file of [process.env.ENV_FILE, new URL("../.env.local", import.meta.url).pathname, new URL("../.env.production", import.meta.url).pathname].filter(Boolean) as string[]) {
  let text: string; try { text = readFileSync(file, "utf8"); } catch { continue; }
  for (const line of text.split("\n")) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
  console.log(`[env] loaded ${file}`); break;
}

const plat = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const bill = createClient(process.env.DA_BILLING_SUPABASE_URL!, process.env.DA_BILLING_SERVICE_ROLE_KEY!);
const KV = "kv_store_0ecc29ad";

async function kvIds(prefix: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await bill.from(KV).select("value").like("key", `${prefix}%`).range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    for (const r of data) if ((r.value as any)?.id) ids.add((r.value as any).id);
    if (data.length < 1000) break;
  }
  return ids;
}
async function platAll(table: string): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await plat.from(table).select("id, name, billing_id, billing_customer_id").range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) break;
    out.push(...data.map((r) => ({ ...r, _table: table })));
    if (data.length < 1000) break;
  }
  return out;
}

(async () => {
  const customerIds = await kvIds("customer:");
  const entities = [...(await platAll("groups")), ...(await platAll("dealers"))];

  // collisions: a billing_id (resolving to a real customer) claimed by >1 entity
  const billCount = new Map<string, number>();
  for (const e of entities) if (e.billing_id && customerIds.has(e.billing_id)) billCount.set(e.billing_id, (billCount.get(e.billing_id) ?? 0) + 1);

  const clean = entities.filter((e) =>
    !e.billing_customer_id && e.billing_id && customerIds.has(e.billing_id) && (billCount.get(e.billing_id) ?? 0) === 1);
  const collisions = entities.filter((e) =>
    !e.billing_customer_id && e.billing_id && customerIds.has(e.billing_id) && (billCount.get(e.billing_id) ?? 0) > 1);

  const g = clean.filter((e) => e._table === "groups").length;
  const d = clean.filter((e) => e._table === "dealers").length;
  console.log(`\nMode: ${WRITE ? "WRITE" : "DRY-RUN (no writes)"}`);
  console.log(`Clean link-missing to backfill: ${clean.length}  (groups ${g}, dealers ${d})`);
  console.log(`Excluded collisions (manual review): ${collisions.length}  ${collisions.map((c) => c.name).join(" | ")}`);

  // planned-changes CSV (gitignored)
  const csv = ["table,id,name,from,to", ...clean.map((e) => `"${e._table}","${e.id}","${(e.name ?? "").replace(/"/g, '""')}","(null)","${e.billing_id}"`)].join("\n");
  writeFileSync(new URL("../billing-link-backfill-plan.csv", import.meta.url), csv);
  console.log("Plan CSV → da-platform/billing-link-backfill-plan.csv");
  console.log("Sample:", clean.slice(0, 5).map((e) => `${e._table}:${e.name} → ${e.billing_id}`));

  if (!WRITE) { console.log("\nDRY-RUN only. Re-run with --write to apply."); return; }

  // WRITE — per-row, idempotent (only when billing_customer_id still null).
  let ok = 0; const fails: string[] = [];
  for (const e of clean) {
    const { error, count } = await plat.from(e._table)
      .update({ billing_customer_id: e.billing_id }, { count: "exact" })
      .eq("id", e.id).is("billing_customer_id", null);
    if (error) fails.push(`${e._table}:${e.id} ${error.message}`);
    else ok += count ?? 0;
  }
  console.log(`\nUpdated ${ok}/${clean.length} rows. Failures: ${fails.length}`);
  for (const f of fails.slice(0, 20)) console.log("  ", f);
})().catch((e) => { console.error(e); process.exit(1); });
