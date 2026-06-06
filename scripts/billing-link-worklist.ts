/**
 * READ-ONLY worklist for the two human-decision slices left after the
 * billing-link backfill (docs/platform-billing-link-sync.md). No writes.
 *   npx tsx scripts/billing-link-worklist.ts
 *
 * Slice 1 — billing_id COLLISIONS (the 4 Greenway dealers; 2 da-billing customers
 *   each claimed by 2 platform dealer rows). Per row: inventory, print activity,
 *   last sign-in, created_at — so Allan can pick the canonical row vs the dup.
 * Slice 2 — SELF-BILLED soft-signal 1:1 candidates: entities with no billing_id
 *   link but a genuine 1:1 email/name match to an active da-billing customer.
 *   Drops group-billed dealers (route to their group's customer) and drops
 *   shared-email clusters (candidate claimed by >1 entity → not 1:1).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

for (const file of [process.env.ENV_FILE, new URL("../.env.local", import.meta.url).pathname, new URL("../.env.production", import.meta.url).pathname].filter(Boolean) as string[]) {
  let t: string; try { t = readFileSync(file, "utf8"); } catch { continue; }
  for (const line of t.split("\n")) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
  console.log(`[env] loaded ${file}`); break;
}

const plat = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const bill = createClient(process.env.DA_BILLING_SUPABASE_URL!, process.env.DA_BILLING_SERVICE_ROLE_KEY!);
const KV = "kv_store_0ecc29ad";
const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");

async function kvByPrefix(prefix: string): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await bill.from(KV).select("value").like("key", `${prefix}%`).range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break; out.push(...data.map((r) => r.value)); if (data.length < 1000) break;
  }
  return out;
}
async function platAll(table: string, cols: string): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await plat.from(table).select(cols).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) break; out.push(...data); if (data.length < 1000) break;
  }
  return out;
}
async function count(table: string, build: (q: any) => any): Promise<number> {
  const { count, error } = await build(plat.from(table).select("id", { count: "exact", head: true }));
  if (error) return -1; return count ?? 0;
}

(async () => {
  const customers = await kvByPrefix("customer:");
  const custById = new Map<string, any>(customers.map((c) => [c.id, c]));
  const byEmail = new Map<string, any>(); const byName = new Map<string, any>();
  for (const c of customers) { if (c.email) byEmail.set(norm(c.email), c); if (c.company) byName.set(norm(c.company), c); if (c.name) byName.set(norm(c.name), c); }

  const groups = await platAll("groups", "id, name, billing_id, billing_customer_id, primary_contact_email, billing_email");
  const dealers = await platAll("dealers", "id, dealer_id, name, billing_id, billing_customer_id, primary_contact_email, subscription_billed_to, created_at, last30, account_type");

  // ── Slice 1: billing_id collisions ─────────────────────────────────────────
  const billCount = new Map<string, number>();
  for (const e of [...groups, ...dealers]) if (!e.billing_customer_id && e.billing_id && custById.has(e.billing_id)) billCount.set(e.billing_id, (billCount.get(e.billing_id) ?? 0) + 1);
  const collisionDealers = dealers.filter((d) => !d.billing_customer_id && d.billing_id && custById.has(d.billing_id) && (billCount.get(d.billing_id) ?? 0) > 1);

  console.log(`\n================ SLICE 1 — billing_id collisions (${collisionDealers.length} rows) ================`);
  const s1: any[] = [];
  // group by da-billing customer
  const byCust: Record<string, any[]> = {};
  for (const d of collisionDealers) (byCust[d.billing_id] ??= []).push(d);
  for (const [custId, ds] of Object.entries(byCust)) {
    const cust = custById.get(custId);
    console.log(`\nda-billing customer ${custId}  "${cust?.company ?? cust?.name ?? "?"}"  ← claimed by ${ds.length} dealer rows:`);
    for (const d of ds) {
      const invActive = await count("dealer_vehicles", (q) => q.eq("dealer_id", d.dealer_id).eq("status", "active"));
      const invTotal = await count("dealer_vehicles", (q) => q.eq("dealer_id", d.dealer_id));
      const prints = await count("print_history", (q) => q.eq("dealer_id", d.dealer_id));
      // last print + last login
      const { data: lastPrint } = await plat.from("dealer_vehicles").select("print_date").eq("dealer_id", d.dealer_id).not("print_date", "is", null).order("print_date", { ascending: false }).limit(1).maybeSingle<{ print_date: string }>();
      const { data: profs } = await plat.from("profiles").select("last_login").eq("dealer_id", d.dealer_id);
      const lastLogin = (profs ?? []).map((p: any) => p.last_login).filter(Boolean).sort().pop() ?? null;
      const row = { dealer: d.name, platform_id: d.id, dealer_id: d.dealer_id, account_type: d.account_type, inv_active: invActive, inv_total: invTotal, prints, last30: d.last30, last_print: lastPrint?.print_date ?? null, users: (profs ?? []).length, last_login: lastLogin, created_at: d.created_at };
      s1.push({ da_customer: custId, da_company: cust?.company ?? cust?.name ?? "", ...row });
      console.log(`   • ${d.name}  (${d.dealer_id})  acct=${d.account_type}  inv=${invActive}a/${invTotal}t  prints=${prints}  last30=${d.last30}  lastPrint=${lastPrint?.print_date ?? "-"}  users=${(profs ?? []).length}  lastLogin=${lastLogin ?? "-"}  created=${d.created_at ?? "-"}`);
    }
  }

  // ── Slice 2: self-billed soft-signal 1:1 candidates ────────────────────────
  type Ent = { kind: "group" | "dealer"; e: any };
  const ents: Ent[] = [...groups.map((e) => ({ kind: "group" as const, e })), ...dealers.map((e) => ({ kind: "dealer" as const, e }))];
  const soft = ents
    .filter(({ e }) => !e.billing_customer_id && !(e.billing_id && custById.has(e.billing_id)))   // genuinely-new (no exact link)
    .filter(({ kind, e }) => !(kind === "dealer" && e.subscription_billed_to === "group"))        // drop group-billed dealers
    .map(({ kind, e }) => {
      const email = kind === "dealer" ? e.primary_contact_email : (e.billing_email ?? e.primary_contact_email);
      const mE = email ? byEmail.get(norm(email)) : null;
      const mN = byName.get(norm(e.name));
      const cand = mE ?? mN ?? null;
      return cand ? { kind, name: e.name, platform_id: e.id, email: email ?? "", candidate: cand.id, candidate_name: cand.company ?? cand.name ?? "", basis: mE ? `email:${email}` : `name:${e.name}` } : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  // keep only 1:1 (candidate referenced by exactly one entity)
  const candCount = new Map<string, number>();
  for (const r of soft) candCount.set(r.candidate, (candCount.get(r.candidate) ?? 0) + 1);
  const s2 = soft.filter((r) => candCount.get(r.candidate) === 1);

  console.log(`\n================ SLICE 2 — self-billed 1:1 soft candidates (${s2.length}; dropped ${soft.length - s2.length} shared-candidate rows) ================`);
  for (const r of s2) console.log(`   ${r.kind} "${r.name}" → ${r.candidate}  "${r.candidate_name}"  [${r.basis}]`);

  // CSVs (gitignored)
  const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  writeFileSync(new URL("../worklist-collisions.csv", import.meta.url), ["da_customer,da_company,dealer,platform_id,dealer_id,account_type,inv_active,inv_total,prints,last30,last_print,users,last_login,created_at", ...s1.map((r) => ["da_customer","da_company","dealer","platform_id","dealer_id","account_type","inv_active","inv_total","prints","last30","last_print","users","last_login","created_at"].map((h) => esc(r[h])).join(","))].join("\n"));
  writeFileSync(new URL("../worklist-soft-1to1.csv", import.meta.url), ["kind,name,platform_id,email,candidate,candidate_name,basis", ...s2.map((r) => ["kind","name","platform_id","email","candidate","candidate_name","basis"].map((h) => esc((r as any)[h])).join(","))].join("\n"));
  console.log("\nCSVs → da-platform/worklist-collisions.csv , worklist-soft-1to1.csv (gitignored)");
})().catch((e) => { console.error(e); process.exit(1); });
