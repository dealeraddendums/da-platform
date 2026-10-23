/**
 * crm-billing-refresh.ts — fetch every DA-Billing customer's status (one POST /customers/statuses) into
 * crm_billing_status, and report what paying dealers / groups now show. --compare also shows how many
 * paying dealers' pills change versus the CRM's old invoice-derived rule (removed 2026-10-23: suspended
 * when billing-status past_due, else past_due when any unpaid invoice was past its due date).
 *
 *   npm run crm:billing-refresh [-- --compare]
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createClient } from "@supabase/supabase-js";
import { loadScriptEnv } from "./crm-env";

loadScriptEnv();

async function main() {
  const { getCustomerStatuses } = await import("../lib/billing");
  const { storeStatuses, payerFor } = await import("../lib/crm/billing-status");
  const admin: any = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

  const page = async (q: (a: number, b: number) => any) => { const out: any[] = []; for (let a = 0; ; a += 1000) { const { data, error } = await q(a, a + 999); if (error) throw new Error(error.message); out.push(...(data ?? [])); if (!data || data.length < 1000) return out; } };
  const dealers = await page((a, b) => admin.from("dealers").select("id, name, dealer_id, subscription_billed_to, billing_customer_id, group_id").order("id").range(a, b));
  const groups = await page((a, b) => admin.from("groups").select("id, name, billing_customer_id").order("id").range(a, b));
  const companies = await page((a, b) => admin.from("crm_companies").select("id, kind, dealer_id, group_id, pipeline_stage").in("kind", ["dealer", "group"]).order("id").range(a, b));
  const gCust = new Map<string, string | null>(groups.map((g: any) => [g.id, g.billing_customer_id]));
  const dById = new Map<string, any>(dealers.map((d: any) => [d.id, d]));

  const ids = new Set<string>();
  for (const d of dealers) { if (d.billing_customer_id) ids.add(d.billing_customer_id); }
  for (const g of groups) { if (g.billing_customer_id) ids.add(g.billing_customer_id); }
  const statuses = await getCustomerStatuses(Array.from(ids));
  await storeStatuses(admin, Object.values(statuses), "sweep");

  const today = new Date().toISOString().slice(0, 10);
  const oldRule = (s: any) => (!s ? null : s.print_locked ? "suspended" : s.oldest_unpaid_due_date && s.oldest_unpaid_due_date < today ? "past_due" : "current");
  const now: Record<string, number> = {}, transitions: Record<string, number> = {};
  const changedRows: string[] = [];
  for (const c of companies) {
    if (c.kind === "dealer" && c.pipeline_stage !== "paying") continue;
    let cust: string | null;
    if (c.kind === "group") cust = gCust.get(c.group_id) ?? null;
    else { const d = dById.get(c.dealer_id); cust = payerFor(d, d?.group_id ? gCust.get(d.group_id) ?? null : null).customerId; }
    const s = cust ? statuses[cust] : null;
    const state = !cust ? "none" : s ? s.status : "unknown";
    now[`${c.kind}:${state}`] = (now[`${c.kind}:${state}`] ?? 0) + 1;
    if (c.kind === "dealer") {
      const before = !cust ? "unknown" : oldRule(s) ?? "unknown";
      if (before !== state) {
        transitions[`${before} → ${state}`] = (transitions[`${before} → ${state}`] ?? 0) + 1;
        if (before === "past_due" && state === "current" && changedRows.length < 400) changedRows.push(dById.get(c.dealer_id)?.name ?? c.id);
      }
    }
  }
  console.log(JSON.stringify({ customers_fetched: Object.keys(statuses).length, requested: ids.size, now, ...(process.argv.includes("--compare") ? { dealer_pill_changes_vs_old_rule: transitions, past_due_to_current: changedRows.sort() } : {}) }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
