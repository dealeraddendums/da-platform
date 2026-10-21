// Feeds queue (Communications → Feeds) — rows, per-view counts, ages.
// Views: mine · needs_info · stalled (older than expected, oldest first) ·
// awaiting_confirmation (Feed ID received) · all (incl. done / cancelled).
// The Unmatched view lists crm_feed_unmatched instead (separate query).
/* eslint-disable @typescript-eslint/no-explicit-any */

import { businessDaysBetween } from "../business-days";
import { ageColor, expectedDays, NEXT_ACTION, OPEN_STATUSES, ORDER_STATUSES, STATUS_LABEL, type OrderStatus } from "./state";
import { companyNames, staffNames } from "../queries";
import { orderNumber } from "./templates";

export const FEED_VIEWS = ["mine", "needs_info", "stalled", "awaiting_confirmation", "unmatched", "all"] as const;
export type FeedView = (typeof FEED_VIEWS)[number];

export type QueueRow = {
  id: string; number: string; status: OrderStatus; status_label: string; age_days: number; age_color: "green" | "amber" | "red";
  dealer_company_id: string; dealer_name: string | null; supplier_company_id: string | null; supplier_name: string | null;
  approver_name: string | null; approver_email: string | null; approver_phone: string | null; owner_staff_id: string | null; owner_name: string | null;
  next_action: string; source: string; feed_id_candidate: string | null; created_at: string; stall_timer_started_at: string;
  email_thread_id: string | null; open_tasks: number;
};

export async function decorateOrders(admin: any, orders: any[], now = new Date()): Promise<QueueRow[]> {
  const supplierIds = Array.from(new Set(orders.map((o) => o.supplier_company_id).filter(Boolean)));
  const [names, staff, { data: settings }, { data: tasks }] = await Promise.all([
    companyNames([...orders.map((o) => o.dealer_company_id), ...supplierIds], admin),
    staffNames(admin),
    supplierIds.length ? admin.from("crm_feed_supplier_settings").select("company_id, typical_turnaround_days").in("company_id", supplierIds) : Promise.resolve({ data: [] }),
    orders.length ? admin.from("crm_tasks").select("feed_order_id").in("feed_order_id", orders.map((o) => o.id)).eq("status", "open") : Promise.resolve({ data: [] }),
  ]);
  const turn = Object.fromEntries((settings ?? []).map((s: any) => [s.company_id, s.typical_turnaround_days]));
  const taskCount: Record<string, number> = {};
  for (const t of tasks ?? []) taskCount[t.feed_order_id] = (taskCount[t.feed_order_id] ?? 0) + 1;
  return orders.map((o) => {
    const age = businessDaysBetween(o.stall_timer_started_at, now);
    const exp = expectedDays(o.status, turn[o.supplier_company_id] ?? 2);
    return {
      id: o.id, number: orderNumber(o.id), status: o.status, status_label: STATUS_LABEL[o.status as OrderStatus] ?? o.status,
      age_days: age, age_color: OPEN_STATUSES.includes(o.status) ? ageColor(age, exp) : "green",
      dealer_company_id: o.dealer_company_id, dealer_name: names[o.dealer_company_id] ?? null,
      supplier_company_id: o.supplier_company_id, supplier_name: o.supplier_company_id ? names[o.supplier_company_id] ?? null : null,
      approver_name: o.approver_name, approver_email: o.approver_email, approver_phone: o.approver_phone,
      owner_staff_id: o.owner_staff_id, owner_name: o.owner_staff_id ? staff[o.owner_staff_id] ?? null : null,
      next_action: NEXT_ACTION[o.status as OrderStatus] ?? "", source: o.source, feed_id_candidate: o.feed_id_candidate,
      created_at: o.created_at, stall_timer_started_at: o.stall_timer_started_at, email_thread_id: o.email_thread_id, open_tasks: taskCount[o.id] ?? 0,
    };
  });
}

const STATUS_ORDER = Object.fromEntries(ORDER_STATUSES.map((s, i) => [s, i]));

export async function queueRows(admin: any, view: FeedView, me: string, opts: { dealerCompanyId?: string } = {}): Promise<QueueRow[]> {
  let q = admin.from("crm_feed_orders").select("*").order("stall_timer_started_at").limit(1000);
  if (opts.dealerCompanyId) q = q.eq("dealer_company_id", opts.dealerCompanyId);
  if (view === "all") q = q.order("created_at", { ascending: false });
  else q = q.in("status", OPEN_STATUSES);
  if (view === "mine") q = q.eq("owner_staff_id", me);
  if (view === "needs_info") q = q.eq("status", "needs_info");
  if (view === "awaiting_confirmation") q = q.eq("status", "feed_id_received");
  const { data } = await q;
  let rows = await decorateOrders(admin, data ?? []);
  if (view === "stalled") rows = rows.filter((r) => r.age_color !== "green").sort((a, b) => b.age_days - a.age_days);
  else rows.sort((a, b) => (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || b.age_days - a.age_days);
  return rows;
}

export async function queueCounts(admin: any, me: string): Promise<Record<FeedView, number>> {
  const [{ data }, { count: unmatched }] = await Promise.all([
    admin.from("crm_feed_orders").select("*").in("status", OPEN_STATUSES).limit(2000),
    admin.from("crm_feed_unmatched").select("id", { count: "exact", head: true }).is("resolved_at", null),
  ]);
  const rows = await decorateOrders(admin, data ?? []);
  const { count: all } = await admin.from("crm_feed_orders").select("id", { count: "exact", head: true });
  return {
    mine: rows.filter((r) => r.owner_staff_id === me).length,
    needs_info: rows.filter((r) => r.status === "needs_info").length,
    stalled: rows.filter((r) => r.age_color !== "green").length,
    awaiting_confirmation: rows.filter((r) => r.status === "feed_id_received").length,
    unmatched: unmatched ?? 0,
    all: all ?? 0,
  };
}
