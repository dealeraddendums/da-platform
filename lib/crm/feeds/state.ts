// DA-CRM feed orders — the ONE place order status changes: advanceOrder(order,
// event). Pure (no database); lib/crm/feeds/orders.ts applies the patch it
// returns, records the event and the timeline entry. UI and API never write
// status directly. Unit tests: scripts/crm-feeds-verify-unit.ts.
//
//   needs_info ⇄ ready ──request_sent──▶ awaiting_dealer_approval ──dealer_approved──▶ awaiting_supplier
//        │          │     (api method ─────────────────────────────────────────────▶ awaiting_supplier)
//        │          │                         │                                        │
//        │          └──────── feed_id_detected / feed_id_entered (any open state) ─────┴──▶ feed_id_received
//        │                                                                                    │ feed_id_confirmed
//        │                                                                                    ▼
//        │                                                                                 assigned ──import_succeeded──▶ done
//        └──────────── cancelled (any open state, reason required) ──▶ cancelled
//
// "request_sent" is recorded as an event; the order moves straight on to
// awaiting_dealer_approval (or awaiting_supplier for portal / API suppliers).
//
// Parent / child (migration 184): the diagram above is the PARENT — one per
// request. Its Feed ID part belongs to the CHILDREN, one per dealership:
//
//   pending ──feed_id_detected / feed_id_entered──▶ feed_id_received ──feed_id_confirmed──▶ assigned ──import_succeeded──▶ done
//      (any open state) ──cancelled──▶ cancelled
//
// and the parent follows them (rollup in orders.ts): the first child with a
// Feed ID → parent feed_id_received ("dealership_feed_id"); every child
// assigned / done / cancelled → parent done ("dealerships_complete").
// The stall timer restarts on every state change and every manual action;
// automatic nudges (the daily job) count stalled_nudges but don't restart it.

export const ORDER_STATUSES = [
  "needs_info", "ready", "request_sent", "awaiting_dealer_approval", "awaiting_supplier",
  "pending", "feed_id_received", "assigned", "done", "cancelled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const OPEN_STATUSES: OrderStatus[] = ["needs_info", "ready", "request_sent", "awaiting_dealer_approval", "awaiting_supplier", "pending", "feed_id_received", "assigned"];
export const isOpen = (s: OrderStatus) => OPEN_STATUSES.includes(s);

import { checkOrderFields, type DealershipAnswers, type ExtraField } from "./extra-fields";

export type RequestMethod = "email" | "pdf" | "api";

export type OrderState = {
  status: OrderStatus;
  /** Set on a dealership's child order. */
  parent_order_id?: string | null;
  supplier_company_id: string | null;
  approver_name: string | null;
  approver_email: string | null;
  approver_phone?: string | null;
  approver_title?: string | null;
  /** Answers to the supplier's questions (extra-fields.ts). */
  supplier_fields?: Record<string, string>;
  feed_id_candidate?: string | null;
  stalled_nudges?: number;
  /** Parent: its dealerships' own answers (per_dealership questions). Absent = one dealership answering on the order itself. */
  dealerships?: DealershipAnswers[];
};

export type OrderEvent =
  | { type: "created" }
  | { type: "info_updated"; fields: Partial<Pick<OrderState, "supplier_company_id" | "approver_name" | "approver_email" | "approver_phone" | "approver_title" | "supplier_fields">> }
  | { type: "request_sent"; threadId: string | null }
  | { type: "resent"; threadId: string | null }
  | { type: "dealer_approved"; via: "email" | "phone" | "signed_pdf" }
  | { type: "supplier_replied" }
  | { type: "feed_id_detected"; candidate: string; source: "regex" | "ai" }
  | { type: "feed_id_entered"; candidate: string }
  | { type: "feed_id_confirmed"; feedId: string; staffId: string }
  | { type: "import_succeeded"; via: "feed_status" | "no_status" }
  | { type: "nudged"; target: "dealer" | "supplier"; manual: boolean }
  | { type: "owner_changed"; ownerId: string | null }
  | { type: "cancelled"; reason: string }
  // Parent rollups (orders.ts → rollupParent)
  | { type: "dealership_feed_id"; fromSupplier: boolean }
  | { type: "dealerships_complete" };

export class TransitionError extends Error {
  constructor(public from: OrderStatus, public event: string, message?: string) {
    super(message ?? `Can't ${event.replace(/_/g, " ")} while the order is ${from.replace(/_/g, " ")}`);
    this.name = "TransitionError";
  }
}

export type Advance = { status: OrderStatus; patch: Record<string, unknown>; changed: boolean };

/**
 * Has what the request needs: a supplier, the approver's name and email unless the supplier uses a
 * portal / API, and valid answers to the supplier's required questions (Autosoft account number…).
 */
export function hasRequiredInfo(o: Pick<OrderState, "supplier_company_id" | "approver_name" | "approver_email" | "supplier_fields" | "dealerships">, method: RequestMethod | null, extraFields: ExtraField[] = []): boolean {
  if (!o.supplier_company_id) return false;
  if (extraFields.length) {
    const c = checkOrderFields(extraFields, o.supplier_fields, o.dealerships ?? [{ name: "", fields: o.supplier_fields }]);
    if (c.missing.length || c.errors.length) return false;
  }
  if (method === "api") return true;
  return !!(o.approver_email && o.approver_name?.trim());
}

const PRE_ID: OrderStatus[] = ["needs_info", "ready", "request_sent", "awaiting_dealer_approval", "awaiting_supplier", "feed_id_received"];
/** Events only a dealership's child order takes, and the ones it never takes. */
const CHILD_ONLY = new Set(["feed_id_detected", "feed_id_entered", "feed_id_confirmed", "import_succeeded"]);
const BOTH = new Set(["created", "info_updated", "cancelled"]);

export function advanceOrder(order: OrderState, ev: OrderEvent, ctx: { method: RequestMethod | null; now?: Date; extraFields?: ExtraField[] }): Advance {
  const now = (ctx.now ?? new Date()).toISOString();
  const s = order.status;
  const restart = { stall_timer_started_at: now, stalled_nudges: 0 };
  const go = (status: OrderStatus, patch: Record<string, unknown> = {}, timer = true): Advance =>
    ({ status, patch: { ...(timer ? restart : {}), ...patch, status }, changed: status !== s });
  const need = (allowed: OrderStatus[]) => { if (!allowed.includes(s)) throw new TransitionError(s, ev.type); };
  const child = !!order.parent_order_id;
  if (child && !CHILD_ONLY.has(ev.type) && !BOTH.has(ev.type)) throw new TransitionError(s, ev.type, `Can't ${ev.type.replace(/_/g, " ")} on one dealership — use the order`);
  if (!child && CHILD_ONLY.has(ev.type)) throw new TransitionError(s, ev.type, "Feed IDs belong to the order's dealerships");

  switch (ev.type) {
    case "created":
      if (child) return go("pending");
      return go(hasRequiredInfo(order, ctx.method, ctx.extraFields) ? "ready" : "needs_info");

    case "info_updated": {
      if (child) { need(["pending", "feed_id_received"]); return go(s, { ...ev.fields }, false); }
      need(PRE_ID);
      const next = { ...order, ...ev.fields };
      if (s === "needs_info" || s === "ready") return go(hasRequiredInfo(next, ctx.method, ctx.extraFields) ? "ready" : "needs_info", { ...ev.fields });
      return go(s, { ...ev.fields });
    }

    case "request_sent":
      need(["ready"]);
      return go(ctx.method === "api" ? "awaiting_supplier" : "awaiting_dealer_approval", { sent_at: now, ...(ev.threadId ? { email_thread_id: ev.threadId } : {}) });

    case "resent":
      need(["awaiting_dealer_approval", "awaiting_supplier"]);
      return go(s, ev.threadId ? { email_thread_id: ev.threadId } : {});

    case "dealer_approved":
      // A signed authorization can arrive after the supplier bounced the first one (Autosoft: wrong
      // transfer row) — it's the dealer's approval again, so awaiting_supplier accepts it too.
      need(ev.via === "signed_pdf" ? ["request_sent", "awaiting_dealer_approval", "awaiting_supplier"] : ["request_sent", "awaiting_dealer_approval"]);
      return go("awaiting_supplier", { dealer_approved_at: now });

    case "supplier_replied":
      need(["request_sent", "awaiting_dealer_approval", "awaiting_supplier", "feed_id_received"]);
      return go(s, { supplier_replied_at: now });

    case "feed_id_detected":
    case "feed_id_entered": {
      need(["pending", "feed_id_received"]);
      const candidate = ev.candidate.trim();
      if (!candidate) throw new TransitionError(s, ev.type, "Feed ID is empty");
      return go("feed_id_received", { feed_id_candidate: candidate, ...(ev.type === "feed_id_detected" ? { supplier_replied_at: now } : {}) });
    }

    case "feed_id_confirmed": {
      need(["feed_id_received"]);
      const id = ev.feedId.trim();
      if (!id) throw new TransitionError(s, ev.type, "Feed ID is empty");
      return go("assigned", { feed_id_confirmed: id, confirmed_by_staff_id: ev.staffId, assigned_at: now });
    }

    case "import_succeeded":
      need(["assigned"]);
      return go("done");

    case "nudged":
      // Supplier: also once some dealerships have their Feed ID and others are still pending.
      need(ev.target === "dealer" ? ["request_sent", "awaiting_dealer_approval"] : ["awaiting_dealer_approval", "awaiting_supplier", "feed_id_received"]);
      return ev.manual ? go(s) : go(s, { stalled_nudges: (order.stalled_nudges ?? 0) + 1 }, false);

    case "owner_changed":
      if (!isOpen(s)) throw new TransitionError(s, ev.type);
      return go(s, { owner_staff_id: ev.ownerId });

    case "cancelled":
      if (!isOpen(s)) throw new TransitionError(s, ev.type);
      if (!ev.reason?.trim()) throw new TransitionError(s, ev.type, "A cancel reason is required");
      return go("cancelled", { cancel_reason: ev.reason.trim() });

    case "dealership_feed_id":
      // Staff can enter a Feed ID before the request even went out (they had it from the dealer).
      need(PRE_ID);
      return go("feed_id_received", ev.fromSupplier ? { supplier_replied_at: now } : {});

    case "dealerships_complete":
      if (!isOpen(s)) throw new TransitionError(s, ev.type);
      return go("done");
  }
}

// ── Stalls (daily job) ───────────────────────────────────────────────────────

export type StallAction = "dealer_followup" | "task_call_approver" | "supplier_followup" | "task_call_supplier" | "escalate_needs_info";

/**
 * What the daily stall job should do for an order, given the business days
 * since its stall timer started. `has` = which of these were already done
 * since the timer last restarted (follow-ups via stalled_nudges; tasks /
 * escalation via open tasks), so each fires once per stall.
 */
export function stallActions(
  o: { status: OrderStatus; stalled_nudges: number },
  businessDays: number,
  turnaroundDays: number,
  has: { callApproverTask?: boolean; callSupplierTask?: boolean; needsInfoTaskOpen?: boolean; escalated?: boolean },
): StallAction[] {
  const out: StallAction[] = [];
  if (o.status === "awaiting_dealer_approval") {
    if (businessDays > 2 && o.stalled_nudges === 0) out.push("dealer_followup");
    if (businessDays > 5 && !has.callApproverTask) out.push("task_call_approver");
  } else if (o.status === "awaiting_supplier") {
    if (businessDays > turnaroundDays + 2 && o.stalled_nudges === 0) out.push("supplier_followup");
    if (businessDays > turnaroundDays + 5 && !has.callSupplierTask) out.push("task_call_supplier");
  } else if (o.status === "needs_info") {
    if (businessDays > 3 && has.needsInfoTaskOpen && !has.escalated) out.push("escalate_needs_info");
  }
  return out;
}

// ── Display ──────────────────────────────────────────────────────────────────

export const STATUS_LABEL: Record<OrderStatus, string> = {
  needs_info: "Needs info", ready: "Ready to send", request_sent: "Request sent",
  awaiting_dealer_approval: "Awaiting dealer approval", awaiting_supplier: "Awaiting supplier",
  pending: "Waiting for Feed ID", feed_id_received: "Feed ID received", assigned: "Assigned", done: "Done", cancelled: "Cancelled",
};

export const NEXT_ACTION: Record<OrderStatus, string> = {
  needs_info: "Get the feed provider / approver — call the GM",
  ready: "Send the request",
  request_sent: "Wait for the dealer's APPROVED",
  awaiting_dealer_approval: "Dealer replies APPROVED (nudge or call)",
  awaiting_supplier: "Supplier sends the Feed ID",
  pending: "Supplier sends this dealership's Feed ID",
  feed_id_received: "Confirm the Feed ID",
  assigned: "First import",
  done: "—",
  cancelled: "—",
};

/** Expected business days in a status (green ≤ expected, amber ≤ 2× expected, red beyond). */
export function expectedDays(status: OrderStatus, turnaroundDays: number): number {
  switch (status) {
    case "needs_info": return 1;
    case "ready": return 1;
    case "request_sent":
    case "awaiting_dealer_approval": return 2;
    case "awaiting_supplier":
    case "pending": return Math.max(1, turnaroundDays);
    case "feed_id_received": return 1;
    case "assigned": return 2;
    default: return 0;
  }
}

export function ageColor(businessDays: number, expected: number): "green" | "amber" | "red" {
  if (businessDays <= expected) return "green";
  if (businessDays <= expected * 2 + 1) return "amber";
  return "red";
}
