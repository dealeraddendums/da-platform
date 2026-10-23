// DA-CRM billing state for dealers and groups — DA-Billing's answer, never derived here.
//
// DA-Billing computes each customer's status by its own rules (GET /customers/:id/status,
// POST /customers/statuses — lib/customer-status.ts in da-billing): past_due when an unpaid invoice is
// older than invoice date + that customer's Overdue Days (default 37; Tuttle Click 200) with no active
// extension — exactly the print lock; archived when the customer is archived; suspended only for an
// explicit DA-Billing suspension (none exist today: its "Service Suspended" notice IS past_due).
//
// We keep DA-Billing's answer in crm_billing_status (migration 191): read it when it's under 15 minutes
// old, otherwise fetch (one batch call for every customer a page needs) and store. billing.status_changed
// events (/api/crm/events) and /api/billing-cache/invalidate keep it fresh between polls. If DA-Billing
// can't be reached, a stale row is shown as is; no row at all reads as unknown — never a guess.
//
// The payer is resolved the way the print lock does it: a group-billed dealer (subscription_billed_to =
// 'group') shows its group's customer. A dealer / group with no DA-Billing customer is "No billing record".
/* eslint-disable @typescript-eslint/no-explicit-any */

import { billingConfigured, getCustomerStatuses, type BillingCustomerStatus } from "@/lib/billing";
import { BILLING_STATE_LABEL, type BillingState } from "./billing-labels";

export { BILLING_STATE_LABEL, type BillingState };
export type BillingDetail = Pick<BillingCustomerStatus, "open_invoices" | "unpaid_balance" | "next_due_date" | "oldest_unpaid_due_date" | "overdue_days" | "extension_active" | "print_locked">;
export type BillingRead = {
  state: BillingState | null;            // null = unknown (DA-Billing unreachable and nothing stored)
  customerId: string | null;
  billedBy: "group" | "self" | null;
  detail: BillingDetail | null;
  fetchedAt: string | null;
  stale?: boolean;
  error?: string;
};

export const MAX_AGE_MS = 15 * 60 * 1000;

/** "3 open invoices · $2,376 · next due Oct 30" (pure). */
export function billingSummary(d: Partial<BillingDetail> | null | undefined): string | null {
  if (!d) return null;
  const n = Number(d.open_invoices ?? 0);
  const parts: string[] = [n === 0 ? "No open invoices" : `${n} open invoice${n === 1 ? "" : "s"}`];
  if (n > 0 && d.unpaid_balance != null) parts.push(`$${Number(d.unpaid_balance).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`);
  if (d.next_due_date) parts.push(`next due ${new Date(`${d.next_due_date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`);
  else if (n > 0 && d.oldest_unpaid_due_date) parts.push(`oldest due ${new Date(`${d.oldest_unpaid_due_date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`);
  return parts.join(" · ");
}

/** Who pays: a group-billed dealer → its group's customer. Pure. */
export function payerFor(dealer: { subscription_billed_to?: string | null; billing_customer_id?: string | null; group_id?: string | null } | null,
  groupCustomerId: string | null): { customerId: string | null; billedBy: "group" | "self" } {
  if (dealer?.subscription_billed_to === "group" && dealer.group_id) return { customerId: groupCustomerId, billedBy: "group" };
  return { customerId: dealer?.billing_customer_id ?? null, billedBy: "self" };
}

export async function billingPayer(admin: any, dealerUuid: string): Promise<{ customerId: string | null; billedBy: "group" | "self" }> {
  const { data: d } = await admin.from("dealers").select("subscription_billed_to, billing_customer_id, group_id").eq("id", dealerUuid).maybeSingle();
  let g: string | null = null;
  if (d?.subscription_billed_to === "group" && d.group_id) {
    g = (await admin.from("groups").select("billing_customer_id").eq("id", d.group_id).maybeSingle()).data?.billing_customer_id ?? null;
  }
  return payerFor(d, g);
}

const pickDetail = (s: any): BillingDetail => ({
  open_invoices: s.open_invoices ?? 0, unpaid_balance: s.unpaid_balance ?? 0, next_due_date: s.next_due_date ?? null,
  oldest_unpaid_due_date: s.oldest_unpaid_due_date ?? null, overdue_days: s.overdue_days ?? 37,
  extension_active: !!s.extension_active, print_locked: !!s.print_locked,
});

/** Store DA-Billing statuses (poll / event / sweep). */
export async function storeStatuses(admin: any, statuses: BillingCustomerStatus[], source: "poll" | "event" | "sweep"): Promise<void> {
  const rows = statuses.filter((s) => s?.customer_id && s.status).map((s) => ({
    customer_id: s.customer_id, status: s.status, detail: s, fetched_at: new Date().toISOString(), source,
  }));
  for (let i = 0; i < rows.length; i += 500) await admin.from("crm_billing_status").upsert(rows.slice(i, i + 500));
}

/** Statuses for many DA-Billing customers: fresh rows as stored, the rest in one DA-Billing call. */
export async function customerStatuses(admin: any, ids: (string | null | undefined)[], maxAgeMs = MAX_AGE_MS): Promise<Map<string, Omit<BillingRead, "customerId" | "billedBy">>> {
  const want = Array.from(new Set(ids.filter(Boolean) as string[]));
  const out = new Map<string, Omit<BillingRead, "customerId" | "billedBy">>();
  if (!want.length) return out;
  const stored = new Map<string, any>();
  for (let i = 0; i < want.length; i += 200) {
    const { data } = await admin.from("crm_billing_status").select("customer_id, status, detail, fetched_at").in("customer_id", want.slice(i, i + 200));
    for (const r of data ?? []) stored.set(r.customer_id, r);
  }
  const now = Date.now();
  const due = want.filter((id) => { const r = stored.get(id); return !r || now - Date.parse(r.fetched_at) > maxAgeMs; });
  let error: string | undefined;
  if (due.length && billingConfigured()) {
    try {
      const fresh = await getCustomerStatuses(due);
      await storeStatuses(admin, Object.values(fresh), "poll");
      for (const s of Object.values(fresh)) stored.set(s.customer_id, { customer_id: s.customer_id, status: s.status, detail: s, fetched_at: new Date().toISOString(), fresh: true });
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 200) : String(e);
    }
  } else if (due.length) error = "DA-Billing not configured";
  for (const id of want) {
    const r = stored.get(id);
    if (!r) { out.set(id, { state: null, detail: null, fetchedAt: null, error: error ?? "Not found in DA-Billing" }); continue; }
    const stale = !r.fresh && now - Date.parse(r.fetched_at) > maxAgeMs;
    out.set(id, { state: r.status as BillingState, detail: pickDetail(r.detail ?? {}), fetchedAt: r.fetched_at, ...(stale ? { stale: true, error } : {}) });
  }
  return out;
}

const NONE: Omit<BillingRead, "billedBy"> = { state: "none", customerId: null, detail: null, fetchedAt: null };

/** One dealer's billing state (group-billed → the group's customer). */
export async function dealerBillingState(admin: any, dealerUuid: string): Promise<BillingRead> {
  const { customerId, billedBy } = await billingPayer(admin, dealerUuid);
  if (!customerId) return { ...NONE, billedBy };
  const r = (await customerStatuses(admin, [customerId])).get(customerId)!;
  return { ...r, customerId, billedBy };
}

/** A group's own DA-Billing customer. */
export async function groupBillingState(admin: any, groupId: string): Promise<BillingRead> {
  const customerId = (await admin.from("groups").select("billing_customer_id").eq("id", groupId).maybeSingle()).data?.billing_customer_id ?? null;
  if (!customerId) return { ...NONE, billedBy: "self" };
  const r = (await customerStatuses(admin, [customerId])).get(customerId)!;
  return { ...r, customerId, billedBy: "self" };
}

/** Many dealers at once (group page members, lists): one payer query + one status batch. */
export async function dealersBillingStates(admin: any, dealerUuids: string[]): Promise<Map<string, BillingRead>> {
  const out = new Map<string, BillingRead>();
  if (!dealerUuids.length) return out;
  const { data: ds } = await admin.from("dealers").select("id, subscription_billed_to, billing_customer_id, group_id").in("id", dealerUuids);
  const groupIds = Array.from(new Set((ds ?? []).filter((d: any) => d.subscription_billed_to === "group" && d.group_id).map((d: any) => d.group_id)));
  const { data: gs } = groupIds.length ? await admin.from("groups").select("id, billing_customer_id").in("id", groupIds) : { data: [] };
  const gCust = new Map<string, string | null>((gs ?? []).map((g: any) => [g.id, g.billing_customer_id]));
  const payers = new Map<string, { customerId: string | null; billedBy: "group" | "self" }>();
  for (const d of ds ?? []) payers.set(d.id, payerFor(d, d.group_id ? gCust.get(d.group_id) ?? null : null));
  const statuses = await customerStatuses(admin, Array.from(payers.values()).map((p) => p.customerId));
  for (const id of dealerUuids) {
    const p = payers.get(id) ?? { customerId: null, billedBy: "self" as const };
    out.set(id, p.customerId ? { ...statuses.get(p.customerId)!, customerId: p.customerId, billedBy: p.billedBy } : { ...NONE, billedBy: p.billedBy });
  }
  return out;
}
