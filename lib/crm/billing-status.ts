// DA-CRM billing state for a paying dealer: Current · Past Due · Suspended.
//
// Read LIVE from DA-Billing (no copy in our database). DA-Billing stores no
// status of its own — it derives it from unpaid invoices — so we use the two
// reads it already exposes to DA Platform (lib/billing.ts, X-API-Key):
//   GET /customers/{id}/billing-status  past_due = an unpaid invoice is older
//       than the customer's Overdue Days grace (default 37). That is exactly
//       when DA Platform locks printing (lib/print-eligibility.ts), so we call
//       it Suspended.
//   GET /invoices?customerId={id}       any unpaid invoice past its dueDate
//       (the customer-facing terms, shorter than the grace) → Past Due.
//   neither → Current.
// The payer is resolved the same way the print lock does: a group-billed
// dealer (subscription_billed_to = 'group') is judged by its group's customer.
// A dealer with no DA-Billing customer, or a DA-Billing error, reads as
// unknown — the pill says "Billing unknown", never a guess.
// DA-Billing rate-limits the API key we share with the platform's print lock
// (429s), so reads are cached 10 minutes and at most two run at once.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { billingConfigured, getBillingStatus, listInvoices } from "@/lib/billing";
import { BILLING_STATE_LABEL, type BillingState } from "./billing-labels";

export { BILLING_STATE_LABEL, type BillingState };
export type BillingRead = { state: BillingState | null; customerId: string | null; billedBy: "group" | "self" | null; error?: string };


const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; state: BillingState }>();
const MAX_CONCURRENT = 2;
let running = 0;
const waiting: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  running++;
  try { return await fn(); } finally { running--; waiting.shift()?.(); }
}

/** Pure: the state from DA-Billing's two reads (unit-tested). */
export function deriveBillingState(pastDue: boolean, invoices: { status?: string | null; dueDate?: string | null; archived?: boolean }[], now: Date): BillingState {
  if (pastDue) return "suspended";
  const today = now.toISOString().slice(0, 10);
  const unpaid = (s?: string | null) => !["paid", "comped", "void", "autopaid", "refunded", "processing"].includes(String(s ?? "").toLowerCase());
  const late = invoices.some((i) => !i.archived && unpaid(i.status) && i.dueDate && String(i.dueDate).slice(0, 10) < today);
  return late ? "past_due" : "current";
}

/** The DA-Billing customer that pays for this dealer (group-billed → the group's). */
export async function billingPayer(admin: any, dealerUuid: string): Promise<{ customerId: string | null; billedBy: "group" | "self" }> {
  const { data: d } = await admin.from("dealers").select("subscription_billed_to, billing_customer_id, group_id").eq("id", dealerUuid).maybeSingle();
  if (d?.subscription_billed_to === "group" && d.group_id) {
    const { data: g } = await admin.from("groups").select("billing_customer_id").eq("id", d.group_id).maybeSingle();
    return { customerId: g?.billing_customer_id ?? null, billedBy: "group" };
  }
  return { customerId: d?.billing_customer_id ?? null, billedBy: "self" };
}

export async function dealerBillingState(admin: any, dealerUuid: string): Promise<BillingRead> {
  if (!billingConfigured()) return { state: null, customerId: null, billedBy: null, error: "DA-Billing not configured" };
  const { customerId, billedBy } = await billingPayer(admin, dealerUuid);
  if (!customerId) return { state: null, customerId: null, billedBy, error: "No DA-Billing customer linked" };
  const hit = cache.get(customerId);
  if (hit && Date.now() - hit.at < TTL_MS) return { state: hit.state, customerId, billedBy };
  try {
    const [status, inv] = await limited(() => Promise.all([getBillingStatus(customerId), listInvoices(customerId)]));
    if (!status) return { state: null, customerId, billedBy, error: "DA-Billing customer not found" };
    const state = deriveBillingState(status.past_due === true, inv.invoices as any[], new Date());
    cache.set(customerId, { at: Date.now(), state });
    return { state, customerId, billedBy };
  } catch (e) {
    return { state: null, customerId, billedBy, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}
