// DA-CRM feed orders — the service every entry point uses (rail / queue / order
// slide-over APIs, the self-serve hook, the feeds@ inbound handler, the daily
// stall job). Status only changes through applyOrderEvent() → advanceOrder()
// (state.ts); each change is a crm_feed_order_events row and a 'feed_order'
// activity on the dealer's timeline. Mail goes out from feeds@ through the
// Inbox send path (lib/crm/inbox-send.ts → composeEmail()).
//
// Parent / child (migration 184): an order is ONE parent per request (thread,
// approver, supplier, request-level answers, the request) and one child per
// dealership (its Feed ID, its per-rooftop answers, its PDF when the supplier
// takes one form per rooftop). Children change through applyOrderEvent() too;
// rollupParent() then moves the parent (first Feed ID → feed_id_received, all
// dealerships assigned / cancelled → done). Child events land on that
// dealership's timeline, parent events on the company the order was started from.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { randomUUID } from "crypto";
import { createAdminSupabaseClient } from "@/lib/db";
import { fireWrite } from "@/lib/db";
import { fireDealerSync } from "@/lib/sync-hubspot";
import { getDealerFeedStatus } from "@/lib/dealer-feed-status";
import { activeVehicleCount, applyFeedIdChange, FeedIdChangeError } from "@/lib/dealer-feed-id";
import { advanceOrder, hasRequiredInfo, isOpen, STATUS_LABEL, TransitionError, type OrderEvent, type OrderStatus, type RequestMethod } from "./state";
import { resolveFeedTemplate, orderNumber, type FeedKind } from "./templates";
import { fillRequestPdf } from "./pdf";
import { checkOrderFields, describeSupplierFields, feedIdField, isPerDealership, parseExtraFields, splitSupplierFields, supplierFieldContext, type ExtraField } from "./extra-fields";
import { matchPdfsToDealerships } from "./detect";
import { businessDaysBetween, nextBusinessDayDue } from "../business-days";
import { sendInboxEmail } from "../inbox-send";
import { relinkThreadActivities } from "../inbox-ingest";
import { putCrmObject } from "../recordings";
import { normEmail } from "../inbox-match";
import { resolveApproverContact } from "./approver";
import type { TemplateContext } from "../template-vars";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

type Admin = any;
export const SYSTEM = "system";

export class FeedOrderError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = "FeedOrderError"; }
}

export type SupplierSettings = {
  company_id: string; request_method: RequestMethod; request_email: string | null; cc_emails: string[];
  pdf_template_s3_key: string | null; pdf_field_map: Record<string, string>; feed_id_pattern: string | null;
  typical_turnaround_days: number; platform_provider: string | null; is_dms: boolean; needs_review: boolean; notes: string | null;
  // 183: per-supplier behaviour (lib/crm/feeds/suppliers.ts documents the three real ones)
  domains: string[]; extra_fields: ExtraField[]; approval_phrases: string[]; cancellation_patterns: string[];
  case_number_pattern: string | null; followup_new_thread: boolean; feed_id_manual: boolean;
};

export const DEFAULT_SETTINGS = (companyId: string): SupplierSettings => ({
  company_id: companyId, request_method: "email", request_email: null, cc_emails: [], pdf_template_s3_key: null, pdf_field_map: {},
  feed_id_pattern: null, typical_turnaround_days: 2, platform_provider: null, is_dms: false, needs_review: true, notes: null,
  domains: [], extra_fields: [], approval_phrases: [], cancellation_patterns: [], case_number_pattern: null, followup_new_thread: false, feed_id_manual: false,
});

const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : []);

export async function supplierSettings(admin: Admin, companyId: string | null): Promise<SupplierSettings | null> {
  if (!companyId) return null;
  const { data } = await admin.from("crm_feed_supplier_settings").select("*").eq("company_id", companyId).maybeSingle();
  if (!data) return DEFAULT_SETTINGS(companyId);
  return {
    ...DEFAULT_SETTINGS(companyId), ...data,
    cc_emails: strList(data.cc_emails), domains: strList(data.domains).map((d) => d.toLowerCase()),
    approval_phrases: strList(data.approval_phrases), cancellation_patterns: strList(data.cancellation_patterns),
    extra_fields: parseExtraFields(data.extra_fields), followup_new_thread: !!data.followup_new_thread, feed_id_manual: !!data.feed_id_manual,
  };
}

export async function loadOrder(admin: Admin, id: string): Promise<any> {
  const { data } = await admin.from("crm_feed_orders").select("*").eq("id", id).maybeSingle();
  if (!data) throw new FeedOrderError(404, "Feed order not found");
  return data;
}

/** The parent of an order id that may be a dealership's child. */
export async function loadParent(admin: Admin, id: string): Promise<any> {
  const o = await loadOrder(admin, id);
  return o.parent_order_id ? loadOrder(admin, o.parent_order_id) : o;
}

export type Dealership = { order: any; companyId: string; name: string; city: string | null; state: string | null };

/** The order's dealerships (children, oldest first) with their names. `open` drops cancelled ones. */
export async function orderDealerships(admin: Admin, parent: any, opts: { open?: boolean } = {}): Promise<Dealership[]> {
  const { data } = await admin.from("crm_feed_orders").select("*").eq("parent_order_id", parent.id).order("created_at");
  const kids: any[] = (data ?? []).filter((k: any) => !opts.open || k.status !== "cancelled");
  const ids = Array.from(new Set(kids.map((k) => k.dealer_company_id)));
  const { data: dir } = ids.length ? await admin.from("crm_company_directory").select("id, name, city, state").in("id", ids) : { data: [] };
  const by = Object.fromEntries((dir ?? []).map((d: any) => [d.id, d]));
  return kids.map((k) => ({ order: k, companyId: k.dealer_company_id, name: by[k.dealer_company_id]?.name ?? "Dealership", city: by[k.dealer_company_id]?.city ?? null, state: by[k.dealer_company_id]?.state ?? null }));
}

/** "A", "A and B", "A, B and C". */
export const joinNames = (names: string[]) => (names.length <= 1 ? names[0] ?? "" : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

// ── Events + timeline ────────────────────────────────────────────────────────

const EVENT_TEXT: Record<string, string> = {
  created: "Feed order started", info_updated: "Order details updated", request_sent: "Feed request sent",
  resent: "Feed request re-sent", dealer_approved: "Dealer approved", supplier_replied: "Supplier replied",
  feed_id_detected: "Feed ID received", feed_id_entered: "Feed ID entered", feed_id_confirmed: "Feed ID confirmed and assigned",
  import_succeeded: "First feed import — dealership done", nudged: "Follow-up sent", owner_changed: "Owner changed", cancelled: "Feed order cancelled",
  task_created: "Task created", signed_pdf_forwarded: "Signed PDF forwarded to the supplier", signed_pdf_uploaded: "Signed PDF uploaded", unmatched_linked: "Email linked to the order", review: "Reply needs review",
  signed_pdf_received: "Signed PDF received from the dealer", case_number: "Supplier case number", cancellation_deadline: "Supplier will cancel without approval",
  supplier_message: "Supplier update", dealership_feed_id: "A dealership's Feed ID arrived", dealerships_complete: "Every dealership set up — order done",
  feed_id_unmatched: "Supplier named a Feed ID no dealership matches",
  dealer_notified: "Dealer told their feed is set up",
};

export async function recordEvent(admin: Admin, order: any, type: string, detail: Record<string, unknown>, actor: string): Promise<void> {
  const at = new Date().toISOString();
  const { error } = await admin.from("crm_feed_order_events").insert({ order_id: order.id, type, detail, actor, occurred_at: at });
  if (error) console.error(`[crm-feeds] event ${order.id} ${type}: ${error.message}`);
  const { error: aErr } = await admin.from("crm_activities").insert({
    company_id: order.dealer_company_id, type: "feed_order", direction: "internal",
    subject: `${EVENT_TEXT[type] ?? type} · ${orderNumber(order.parent_order_id ?? order.id)}`,
    body: typeof detail.note === "string" ? detail.note : typeof detail.reason === "string" ? detail.reason : null,
    metadata: { feed_order_id: order.parent_order_id ?? order.id, ...(order.parent_order_id ? { dealership_order_id: order.id } : {}), event: type, status: order.status, ...pick(detail, ["feed_id", "candidate", "target", "via", "email_id", "thread_id"]) },
    occurred_at: at, actor_staff_id: actor === SYSTEM ? null : actor,
  });
  if (aErr) console.error(`[crm-feeds] activity ${order.id} ${type}: ${aErr.message}`);
}

const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => o[k] != null).map((k) => [k, o[k]]));

/** advanceOrder()'s view of a parent: its dealerships' own answers (per-rooftop questions). */
async function stateFor(admin: Admin, order: any): Promise<any> {
  if (order.parent_order_id) return order;
  const kids = await orderDealerships(admin, order, { open: true });
  return kids.length ? { ...order, dealerships: kids.map((k) => ({ name: k.name, fields: k.order.supplier_fields })) } : order;
}

/** The only status writer: advanceOrder() + a guarded update + the event (+ the parent's rollup for a child). */
export async function applyOrderEvent(admin: Admin, orderId: string, ev: OrderEvent, actor: string, detail: Record<string, unknown> = {}): Promise<any> {
  const order = await loadOrder(admin, orderId);
  const parent = order.parent_order_id ? await loadOrder(admin, order.parent_order_id) : order;
  const settings = await supplierSettings(admin, parent.supplier_company_id);
  const adv = advanceOrder(await stateFor(admin, order), ev, { method: settings?.request_method ?? null, extraFields: settings?.extra_fields ?? [] });
  const { data, error } = await admin.from("crm_feed_orders").update(adv.patch).eq("id", orderId).eq("status", order.status).select("*").maybeSingle();
  if (error) throw new FeedOrderError(500, error.message);
  if (!data) throw new FeedOrderError(409, "The order changed while you were working on it — reload and try again");
  await recordEvent(admin, data, ev.type, { ...evDetail(ev), ...detail, from: order.status, to: data.status }, actor);
  if (adv.changed) await onStatusChange(admin, order.status, data);
  if (data.parent_order_id && adv.changed) await rollupParent(admin, data.parent_order_id, actor, ev.type === "feed_id_detected");
  return data;
}

function evDetail(ev: OrderEvent): Record<string, unknown> {
  const { type: _t, ...rest } = ev as any;
  return rest;
}

/** Close tasks that no longer apply once the order moves on. */
async function onStatusChange(admin: Admin, from: OrderStatus, order: any): Promise<void> {
  const done: Record<string, string[]> = order.parent_order_id
    ? { feed_id_received: ["feed_enter_feed_id"], assigned: ["feed_confirm_id", "feed_enter_feed_id"] }
    : {
        ready: ["feed_get_info"], awaiting_dealer_approval: ["feed_get_info"],
        awaiting_supplier: ["feed_get_info", "feed_call_approver", "feed_review_dealer_reply", "feed_supplier_deadline"],
        feed_id_received: ["feed_call_supplier", "feed_call_approver"],
      };
  const kinds = order.status === "cancelled" || order.status === "done" ? null : done[order.status];
  let q = admin.from("crm_tasks").update({ status: "done", completed_at: new Date().toISOString() }).eq("feed_order_id", order.id).eq("status", "open");
  if (kinds) q = q.in("kind", kinds);
  if (kinds || !isOpen(order.status)) await q;
  void from;
}

/**
 * Move the parent after a dealership changed: the first Feed ID → feed_id_received; once none
 * is still waiting, the order-level "enter Feed ID" task closes; every dealership assigned /
 * done / cancelled → done (all cancelled → cancelled).
 */
async function rollupParent(admin: Admin, parentId: string, actor: string, fromSupplier: boolean): Promise<void> {
  const parent = await loadOrder(admin, parentId);
  if (!isOpen(parent.status)) return;
  const kids = (await orderDealerships(admin, parent)).map((k) => k.order);
  if (!kids.length) return;
  const withId = kids.filter((k) => ["feed_id_received", "assigned", "done"].includes(k.status));
  let p = parent;
  if (withId.length && parent.status !== "feed_id_received") {
    try { p = await applyOrderEvent(admin, parent.id, { type: "dealership_feed_id", fromSupplier }, actor, { note: `${withId.length} of ${kids.filter((k) => k.status !== "cancelled").length} dealership${kids.length === 1 ? "" : "s"} have a Feed ID` }); }
    catch (e) { if (!(e instanceof TransitionError)) throw e; }
  }
  if (!kids.some((k) => k.status === "pending")) {
    await admin.from("crm_tasks").update({ status: "done", completed_at: new Date().toISOString() }).eq("feed_order_id", parent.id).eq("kind", "feed_enter_feed_id").eq("status", "open");
  }
  if (kids.every((k) => ["assigned", "done", "cancelled"].includes(k.status))) {
    if (kids.every((k) => k.status === "cancelled")) await applyOrderEvent(admin, p.id, { type: "cancelled", reason: "Every dealership on the order was cancelled" }, actor);
    else await applyOrderEvent(admin, p.id, { type: "dealerships_complete" }, actor);
  }
}

// ── Tasks ────────────────────────────────────────────────────────────────────

export async function createOrderTask(admin: Admin, order: any, t: { kind: string; title: string; description?: string | null; assignee?: string | null; due?: string | null; capability?: string | null }, actor: string): Promise<string | null> {
  // One open task per kind per order (a dealership's child counts as its own order).
  const { data: open } = await admin.from("crm_tasks").select("id").eq("feed_order_id", order.id).eq("kind", t.kind).eq("status", "open").maybeSingle();
  if (open) return open.id;
  const { data, error } = await admin.from("crm_tasks").insert({
    company_id: order.dealer_company_id, title: t.title, description: t.description ?? null, kind: t.kind, feed_order_id: order.id,
    assigned_staff_id: t.assignee ?? order.owner_staff_id ?? null, assigned_capability: t.capability ?? null,
    due_at: t.due ?? nextBusinessDayDue(), status: "open", created_by: actor === SYSTEM ? null : actor,
  }).select("id").single();
  if (error) { console.error(`[crm-feeds] task ${order.id}: ${error.message}`); return null; }
  await recordEvent(admin, order, "task_created", { kind: t.kind, note: t.title }, actor);
  return data.id;
}

// ── Owners ───────────────────────────────────────────────────────────────────

/** Preferred → the dealer's company owner → the feed_support team member with the fewest open orders. */
export async function resolveOwner(admin: Admin, dealerCompanyId: string, preferred: string | null): Promise<string | null> {
  if (preferred) return preferred;
  const { data: co } = await admin.from("crm_companies").select("owner_staff_id").eq("id", dealerCompanyId).maybeSingle();
  if (co?.owner_staff_id) return co.owner_staff_id;
  return feedSupportAssignee(admin);
}

export async function feedSupportAssignee(admin: Admin): Promise<string | null> {
  const { data: team } = await admin.from("crm_staff_profiles").select("staff_id").contains("capabilities", ["feed_support"]).eq("active", true);
  const ids: string[] = (team ?? []).map((t: any) => t.staff_id);
  if (!ids.length) return null;
  const { data: open } = await admin.from("crm_feed_orders").select("owner_staff_id").in("owner_staff_id", ids).is("parent_order_id", null).not("status", "in", "(done,cancelled)");
  const load = Object.fromEntries(ids.map((id) => [id, 0]));
  for (const o of open ?? []) load[o.owner_staff_id] = (load[o.owner_staff_id] ?? 0) + 1;
  return ids.sort((a, b) => load[a] - load[b] || a.localeCompare(b))[0];
}

// ── Create / update ──────────────────────────────────────────────────────────

export type CreateInput = {
  /** The company the order starts from: a dealer, or a group (then `dealershipCompanyIds` picks its rooftops). */
  dealerCompanyId: string; supplierCompanyId?: string | null; source: "call" | "chat" | "email" | "self_serve";
  initiatedBy?: string | null; ownerId?: string | null; approverName?: string | null; approverEmail?: string | null; approverPhone?: string | null;
  approverTitle?: string | null; notes?: string | null; emailThreadId?: string | null;
  /** The approver picked from the company's (or its group's) contacts. Typed-in approvers become contacts (lib/crm/feeds/approver.ts). */
  approverContactId?: string | null;
  /** Answers to the supplier's extra_fields (Autosoft: go_dealer, transfer_row; a one-dealership order may put autosoft_account here too). */
  supplierFields?: Record<string, unknown> | null;
  /** Group orders: the rooftops (dealer company ids) the request covers. */
  dealershipCompanyIds?: string[] | null;
  /** Per-rooftop answers (per_dealership questions — Autosoft account), keyed by dealer company id. */
  dealershipFields?: Record<string, Record<string, unknown>> | null;
  /** PDF suppliers, several rooftops: one form each (default) or one for all. */
  pdfMode?: "per_dealership" | "combined" | null;
};

/** Clean + validate answers for this supplier's questions; wrong answers are a 400, missing ones leave the order in Needs info. */
export function cleanSupplierFields(settings: SupplierSettings | null, input: Record<string, unknown> | null | undefined, dealerships: { name: string; fields: Record<string, unknown> | null | undefined }[] = [{ name: "", fields: input }]): { request: Record<string, string>; dealerships: Record<string, string>[] } {
  const c = checkOrderFields(settings?.extra_fields ?? [], input, dealerships);
  if (c.errors.length) throw new FeedOrderError(400, c.errors.join(". "));
  return { request: c.request, dealerships: c.dealerships };
}

/** A dealership's Feed ID candidate before the supplier says anything: the answer that IS the Feed ID (Autosoft account). */
const prefilledFeedId = (defs: ExtraField[], fields: Record<string, string>) => {
  const f = feedIdField(defs);
  return f ? fields[f.key] ?? null : null;
};

/** The rooftops a group order may cover (dealer companies whose dealer belongs to the group). */
export async function groupRooftops(admin: Admin, groupCompanyId: string): Promise<{ id: string; name: string; city: string | null; state: string | null; active: boolean }[]> {
  const { data: g } = await admin.from("crm_company_directory").select("kind, group_id").eq("id", groupCompanyId).maybeSingle();
  if (g?.kind !== "group" || !g.group_id) return [];
  const { data } = await admin.from("crm_company_directory").select("id, name, city, state, active").eq("kind", "dealer").eq("parent_group_id", g.group_id).order("name");
  return data ?? [];
}

export async function createFeedOrder(admin: Admin, input: CreateInput): Promise<{ order: any; existed: boolean }> {
  const { data: start } = await admin.from("crm_companies").select("id, kind").eq("id", input.dealerCompanyId).maybeSingle();
  if (!start || !["dealer", "group"].includes(start.kind)) throw new FeedOrderError(400, "Feed orders are for dealers (or a group's dealerships)");
  if (input.supplierCompanyId) {
    const { data: s } = await admin.from("crm_companies").select("kind").eq("id", input.supplierCompanyId).maybeSingle();
    if (s?.kind !== "feed_supplier") throw new FeedOrderError(400, "That company isn't a feed supplier");
  }
  let rooftops: string[];
  if (start.kind === "dealer") rooftops = [input.dealerCompanyId];
  else {
    const allowed = new Set((await groupRooftops(admin, input.dealerCompanyId)).map((r) => r.id));
    rooftops = Array.from(new Set((input.dealershipCompanyIds ?? []).filter((id) => typeof id === "string")));
    if (!rooftops.length) throw new FeedOrderError(400, "Tick the dealerships this feed request is for");
    const stray = rooftops.filter((id) => !allowed.has(id));
    if (stray.length) throw new FeedOrderError(400, "Some of those dealerships aren't in this group");
  }

  // One open order per dealership: a second "Start feed order" (or self-serve racing staff) reuses it.
  const { data: busy } = await admin.from("crm_feed_orders").select("*").in("dealer_company_id", rooftops).not("parent_order_id", "is", null).not("status", "in", "(done,cancelled)");
  if (busy?.length) {
    const parents = Array.from(new Set(busy.map((b: any) => b.parent_order_id)));
    if (rooftops.length === 1 && parents.length === 1) return { order: await fillGaps(admin, await loadOrder(admin, parents[0] as string), input), existed: true };
    const { data: names } = await admin.from("crm_company_directory").select("id, name").in("id", busy.map((b: any) => b.dealer_company_id));
    throw new FeedOrderError(409, `Already on an open feed order: ${(names ?? []).map((n: any) => `${n.name} (${orderNumber(busy.find((b: any) => b.dealer_company_id === n.id).parent_order_id)})`).join(", ")} — open that order or leave them out`);
  }

  const owner = await resolveOwner(admin, input.dealerCompanyId, input.ownerId ?? input.initiatedBy ?? null);
  const settings = await supplierSettings(admin, input.supplierCompanyId ?? null);
  const approver = await approverContactFor(admin, input);
  if (approver) input = withApproverFields(input, approver.contact);
  const defs = settings?.extra_fields ?? [];
  const { data: dir } = await admin.from("crm_company_directory").select("id, name").in("id", rooftops);
  const nameOf = (id: string) => (dir ?? []).find((d: any) => d.id === id)?.name ?? "Dealership";
  // One dealership: its answers may all come in supplierFields. Several: per-rooftop ones in dealershipFields.
  const perRoof = rooftops.map((id) => ({ name: nameOf(id), fields: rooftops.length === 1 ? { ...(input.supplierFields ?? {}), ...(input.dealershipFields?.[id] ?? {}) } : input.dealershipFields?.[id] ?? {} }));
  const answers = cleanSupplierFields(settings, input.supplierFields, perRoof);

  const base = {
    status: "needs_info" as OrderStatus, supplier_company_id: input.supplierCompanyId ?? null,
    approver_name: input.approverName?.trim() || null, approver_email: normEmail(input.approverEmail) ?? null,
    supplier_fields: answers.request,
  };
  const adv = advanceOrder({ ...base, dealerships: perRoof.map((r, i) => ({ name: r.name, fields: answers.dealerships[i] })) }, { type: "created" }, { method: settings?.request_method ?? null, extraFields: defs });
  const { data: order, error } = await admin.from("crm_feed_orders").insert({
    ...base, ...adv.patch, dealer_company_id: input.dealerCompanyId, source: input.source,
    initiated_by_staff_id: input.initiatedBy ?? null, owner_staff_id: owner, approver_phone: input.approverPhone?.trim() || null,
    approver_title: input.approverTitle?.trim() || null, pdf_mode: input.pdfMode === "combined" ? "combined" : "per_dealership",
    approver_contact_id: approver?.id ?? null,
    notes: input.notes?.trim() || null, email_thread_id: input.emailThreadId ?? null,
  }).select("*").single();
  if (error) throw new FeedOrderError(500, error.message);
  const kids: any[] = [];
  for (let i = 0; i < rooftops.length; i++) {
    const id = rooftops[i];
    const fields = answers.dealerships[i];
    const { data: kid, error: kErr } = await admin.from("crm_feed_orders").insert({
      parent_order_id: order.id, dealer_company_id: id, supplier_company_id: order.supplier_company_id, source: input.source,
      status: "pending", supplier_fields: fields, feed_id_candidate: prefilledFeedId(defs, fields),
      owner_staff_id: owner, initiated_by_staff_id: input.initiatedBy ?? null,
    }).select("*").single();
    if (kErr) {
      // Raced another create for the same dealership: undo ours (children cascade) and hand back theirs.
      await admin.from("crm_feed_orders").delete().eq("id", order.id);
      if (kErr.code === "23505") return createFeedOrder(admin, input);
      throw new FeedOrderError(500, kErr.message);
    }
    kids.push(kid);
  }
  if (order.email_thread_id) await linkThread(admin, order.email_thread_id, order.id);
  const described = [
    describeSupplierFields(defs.filter((f) => !isPerDealership(f)), order.supplier_fields ?? {}),
    ...kids.map((k, i) => { const d = describeSupplierFields(defs.filter(isPerDealership), k.supplier_fields ?? {}); return kids.length > 1 ? `${perRoof[i].name}${d ? `: ${d}` : ""}` : d; }),
  ].filter(Boolean).join(" · ");
  await recordEvent(admin, order, "created", { source: input.source, note: [input.notes, described].filter(Boolean).join(" — ") || null }, input.initiatedBy ?? SYSTEM);
  if (kids.length > 1 || order.dealer_company_id !== kids[0].dealer_company_id) {
    for (const k of kids) await recordEvent(admin, k, "created", { source: input.source, note: `Part of feed order ${orderNumber(order.id)} for ${joinNames(perRoof.map((r) => r.name))}` }, input.initiatedBy ?? SYSTEM);
  }
  if (order.status === "needs_info") {
    const missing = missingInfo(order, settings?.request_method ?? null, defs, perRoof.map((r, i) => ({ name: r.name, fields: answers.dealerships[i] })));
    await createOrderTask(admin, order, {
      kind: "feed_get_info", title: "Get feed provider/approver — call the GM",
      description: `Missing: ${missing.join(", ")}.`, assignee: input.initiatedBy ?? owner,
    }, input.initiatedBy ?? SYSTEM);
  }
  if (input.source === "self_serve" && owner) {
    await createOrderTask(admin, order, { kind: "feed_self_serve", title: "New self-serve feed upgrade — review the order", assignee: owner }, SYSTEM);
  }
  return { order, existed: false };
}

/** The approver as a contact: linked when picked, created / deduped when typed. A lookup failure never blocks the order. */
async function approverContactFor(admin: Admin, input: CreateInput): Promise<{ id: string; contact: any } | null> {
  try {
    return await resolveApproverContact(admin, input.dealerCompanyId, {
      contactId: input.approverContactId ?? null, name: input.approverName, email: input.approverEmail, phone: input.approverPhone, title: input.approverTitle,
    });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (m === "not_allowed" || m === "not_found") throw new FeedOrderError(400, "That approver isn't a contact of this dealer or its group");
    console.error("[crm-feeds] approver contact:", m);
    return null;
  }
}

/** Blank approver fields on the input take the linked contact's values. Pure. */
export function withApproverFields(input: CreateInput, c: any): CreateInput {
  const name = [c?.first_name, c?.last_name].filter(Boolean).join(" ");
  return {
    ...input,
    approverName: input.approverName?.trim() || name || null,
    approverEmail: input.approverEmail?.trim() || c?.email || null,
    approverPhone: input.approverPhone?.trim() || c?.phone || c?.phone_raw || null,
    approverTitle: input.approverTitle?.trim() || c?.title || null,
  };
}

/** A second "Start feed order" for the same single dealership: fill gaps (never overwrite what staff already have). */
async function fillGaps(admin: Admin, existing: any, input: CreateInput): Promise<any> {
  if (!existing.approver_contact_id && (input.approverContactId || input.approverName || input.approverEmail)) {
    const approver = await approverContactFor(admin, input);
    if (approver) {
      input = withApproverFields(input, approver.contact);
      await admin.from("crm_feed_orders").update({ approver_contact_id: approver.id }).eq("id", existing.id);
      existing = { ...existing, approver_contact_id: approver.id };
    }
  }
  const fill: Record<string, unknown> = {};
  if (!existing.supplier_company_id && input.supplierCompanyId) fill.supplier_company_id = input.supplierCompanyId;
  if (!existing.approver_email && input.approverEmail) fill.approver_email = normEmail(input.approverEmail);
  if (!existing.approver_name && input.approverName) fill.approver_name = input.approverName.trim();
  if (!existing.approver_phone && input.approverPhone) fill.approver_phone = input.approverPhone.trim();
  if (!existing.approver_title && input.approverTitle) fill.approver_title = input.approverTitle.trim();
  if (input.supplierFields) {
    const kids = await orderDealerships(admin, existing, { open: true });
    if (!Object.keys(existing.supplier_fields ?? {}).length && !kids.some((k) => Object.keys(k.order.supplier_fields ?? {}).length)) fill.supplier_fields = input.supplierFields;
  }
  if (Object.keys(fill).length && ["needs_info", "ready"].includes(existing.status)) {
    return updateOrderInfo(admin, existing.id, fill as any, input.initiatedBy ?? SYSTEM, `Details added (${input.source})`);
  }
  if (input.emailThreadId && !existing.email_thread_id) await admin.from("crm_feed_orders").update({ email_thread_id: input.emailThreadId }).eq("id", existing.id);
  return existing;
}

export function missingInfo(o: any, method: RequestMethod | null, extraFields: ExtraField[] = [], dealerships?: { name: string; fields: Record<string, unknown> | null | undefined }[]): string[] {
  const m: string[] = [];
  if (!o.supplier_company_id) m.push("feed provider");
  if (method !== "api") {
    if (!o.approver_name) m.push("approver name");
    if (!o.approver_email) m.push("approver email");
  }
  if (o.supplier_company_id && extraFields.length) {
    const c = checkOrderFields(extraFields, o.supplier_fields, dealerships ?? [{ name: "", fields: o.supplier_fields }]);
    m.push(...c.missing.map((l) => l.charAt(0).toLowerCase() + l.slice(1)), ...c.errors);
  }
  return m;
}

/** missingInfo() for a stored parent (reads its dealerships). */
export async function orderMissingInfo(admin: Admin, parent: any, settings: SupplierSettings | null): Promise<string[]> {
  const kids = await orderDealerships(admin, parent, { open: true });
  return missingInfo(parent, settings?.request_method ?? null, settings?.extra_fields ?? [], kids.map((k) => ({ name: k.name, fields: k.order.supplier_fields })));
}

/**
 * Change approver / supplier / answers. `supplier_fields` = the request-level answers (for a
 * one-dealership order, per-rooftop answers in it go to the dealership too); `dealership_fields`
 * = { childOrderId: answers } for the per-rooftop questions. A pending dealership whose Feed ID
 * candidate came from its answer (Autosoft account) follows the new answer.
 */
export async function updateOrderInfo(admin: Admin, orderId: string, fields: { pdf_mode?: "per_dealership" | "combined"; supplier_company_id?: string | null; approver_name?: string | null; approver_email?: string | null; approver_phone?: string | null; approver_title?: string | null; supplier_fields?: Record<string, unknown> | null; dealership_fields?: Record<string, Record<string, unknown>> | null }, actor: string, note?: string): Promise<any> {
  const cur = await loadParent(admin, orderId);
  const clean: Record<string, unknown> = {};
  if ("supplier_company_id" in fields) {
    if (fields.supplier_company_id) {
      const { data: s } = await admin.from("crm_companies").select("kind").eq("id", fields.supplier_company_id).maybeSingle();
      if (s?.kind !== "feed_supplier") throw new FeedOrderError(400, "That company isn't a feed supplier");
    }
    clean.supplier_company_id = fields.supplier_company_id || null;
  }
  if ("approver_name" in fields) clean.approver_name = fields.approver_name?.trim() || null;
  if ("approver_email" in fields) {
    const e = fields.approver_email?.trim() ? normEmail(fields.approver_email) : null;
    if (fields.approver_email?.trim() && !e) throw new FeedOrderError(400, "That approver email doesn't look right");
    clean.approver_email = e;
  }
  if ("approver_phone" in fields) clean.approver_phone = fields.approver_phone?.trim() || null;
  if ("approver_title" in fields) clean.approver_title = fields.approver_title?.trim() || null;
  // One form per dealership or one for all (already sent? Resend request sends the new form(s)).
  if (fields.pdf_mode) clean.pdf_mode = fields.pdf_mode === "combined" ? "combined" : "per_dealership";
  if ("supplier_fields" in fields || "dealership_fields" in fields || "supplier_company_id" in clean) {
    const supplierId = ("supplier_company_id" in clean ? clean.supplier_company_id : cur.supplier_company_id) as string | null;
    const settings = await supplierSettings(admin, supplierId);
    const defs = settings?.extra_fields ?? [];
    const kids = await orderDealerships(admin, cur, { open: true });
    const reqIn = "supplier_fields" in fields ? fields.supplier_fields : cur.supplier_fields;
    // A new supplier asks different questions: keep only what it understands.
    const perRoof = kids.map((k) => ({
      name: k.name,
      fields: { ...(k.order.supplier_fields ?? {}), ...(kids.length === 1 && "supplier_fields" in fields ? splitSupplierFields(defs, toStrings(fields.supplier_fields)).dealership : {}), ...(fields.dealership_fields?.[k.order.id] ?? {}) },
    }));
    const answers = cleanSupplierFields(settings, reqIn, perRoof);
    clean.supplier_fields = answers.request;
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      const next = answers.dealerships[i];
      if (JSON.stringify(next) === JSON.stringify(k.order.supplier_fields ?? {}) && supplierId === k.order.supplier_company_id) continue;
      const patch: Record<string, unknown> = { supplier_fields: next, supplier_company_id: supplierId };
      const before = prefilledFeedId(defs, k.order.supplier_fields ?? {}), after = prefilledFeedId(defs, next);
      if (k.order.status === "pending" && (!k.order.feed_id_candidate || k.order.feed_id_candidate === before)) patch.feed_id_candidate = after;
      await admin.from("crm_feed_orders").update(patch).eq("id", k.order.id);
    }
  }
  return applyOrderEvent(admin, cur.id, { type: "info_updated", fields: clean as any }, actor, note ? { note } : {});
}

const toStrings = (v: Record<string, unknown> | null | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(v ?? {}).filter(([, x]) => typeof x === "string").map(([k, x]) => [k, String(x)]));

// ── Template context ─────────────────────────────────────────────────────────

const longDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "long", day: "numeric", year: "numeric" }) : null);

/**
 * The order's variables. `opts.dealership` = one child: its Feed ID and its own answers (that
 * rooftop's PDF, its Feed assigned email). Without it: every open dealership — order.dealerships
 * ("A and B"), order.dealership_list (Dealership / Location lines), and per-rooftop answers
 * joined with "/" (Autosoft's own style: "CEDB17/CEDB75").
 */
export async function orderTemplateContext(admin: Admin, order: any, opts: { dealership?: any } = {}): Promise<TemplateContext> {
  if (order?.parent_order_id) return orderTemplateContext(admin, await loadOrder(admin, order.parent_order_id), { dealership: order });
  if (!order?.id) return {};
  const [{ data: sup }, settings, kidsAll] = await Promise.all([
    order.supplier_company_id ? admin.from("crm_company_directory").select("name").eq("id", order.supplier_company_id).maybeSingle() : Promise.resolve({ data: null }),
    supplierSettings(admin, order.supplier_company_id),
    orderDealerships(admin, order, { open: true }),
  ]);
  const kids = opts.dealership ? kidsAll.filter((k) => k.order.id === opts.dealership.id) : kidsAll;
  const first = kids[0]?.companyId ?? order.dealer_company_id;
  const { data: co } = await admin.from("crm_companies").select("dealer_id").eq("id", first).maybeSingle();
  const { data: dealer } = co?.dealer_id ? await admin.from("dealers").select("inventory_provider, inventory_provider_is_dms").eq("id", co.dealer_id).maybeSingle() : { data: null };
  const dms = settings?.is_dms ? (settings.platform_provider ?? sup?.name ?? null) : dealer?.inventory_provider_is_dms ? dealer.inventory_provider : null;
  // The approver's title: what staff typed on the order, else their contact card (any of the order's companies).
  let title: string | null = order.approver_title ?? null;
  if (!title && order.approver_email) {
    const { data: c } = await admin.from("crm_contacts").select("title").in("company_id", Array.from(new Set([order.dealer_company_id, ...kidsAll.map((k) => k.companyId)]))).ilike("email", order.approver_email).is("deleted_at", null).limit(1).maybeSingle();
    title = c?.title ?? null;
  }
  const defs = settings?.extra_fields ?? [];
  const perKeys = defs.filter(isPerDealership).map((f) => f.key);
  const merged: Record<string, string> = { ...(order.supplier_fields ?? {}) };
  for (const k of perKeys) {
    const vals = Array.from(new Set(kids.map((d) => d.order.supplier_fields?.[k]).filter(Boolean)));
    if (vals.length) merged[k] = vals.join("/");
  }
  const ids = kids.map((d) => d.order.feed_id_confirmed ?? d.order.feed_id_candidate).filter(Boolean);
  return {
    "supplier.name": sup?.name ?? null, "supplier.request_email": settings?.request_email ?? null,
    "approver.name": order.approver_name, "approver.first_name": (order.approver_name ?? "").trim().split(/\s+/)[0] || null, "approver.email": order.approver_email,
    "approver.title": title,
    // No fax on dealer / company records yet — the variable exists so PDF maps can name it (renders blank).
    "company.fax": null,
    "dealer.dms": dms, "order.id": orderNumber(order.id), "order.sent_on": longDate(order.sent_at),
    "order.feed_id": ids.length ? ids.join("/") : null,
    "order.case_number": order.metadata?.case_number ?? null,
    ...(kids.length ? {
      "order.dealerships": joinNames(kids.map((d) => d.name)),
      "order.dealership_count": kids.length,
      "order.dealership_list": kids.map((d) => `Dealership: ${d.name}${d.city || d.state ? `\nLocation: ${[d.city, d.state].filter(Boolean).join(", ")}` : ""}`).join("\n\n"),
    } : {}),
    ...supplierFieldContext(defs, merged),
  };
}

/** Mark a thread as belonging to an order (detection finds the order from any of its threads). */
export async function linkThread(admin: Admin, threadId: string | null, orderId: string): Promise<void> {
  if (!threadId) return;
  const { error } = await admin.from("crm_email_threads").update({ feed_order_id: orderId }).eq("id", threadId).is("feed_order_id", null);
  if (error) console.error(`[crm-feeds] link thread ${threadId} → ${orderId}: ${error.message}`);
}

// ── Sending ──────────────────────────────────────────────────────────────────

async function feedsMailbox(admin: Admin): Promise<{ id: string; address: string }> {
  const { data } = await admin.from("crm_mailboxes").select("id, address, active").eq("purpose", "feeds").eq("active", true).order("address").limit(1).maybeSingle();
  if (!data) throw new FeedOrderError(503, "The feeds@ mailbox isn't set up in DA-CRM");
  return data;
}

function s3(): S3Client {
  return new S3Client({ region: "us-west-1", credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID!, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY! } });
}
async function getCrmObject(key: string): Promise<Buffer> {
  const r = await s3().send(new GetObjectCommand({ Bucket: "dealer-addendums", Key: key }));
  return Buffer.from(await (r.Body as any).transformToByteArray());
}

/** Mail + S3 seams (the fixture tests swap these for recorders; nothing else should). */
export const feedIo = {
  send: (...args: Parameters<typeof sendInboxEmail>) => sendInboxEmail(...args),
  getObject: (key: string) => getCrmObject(key),
  putObject: (key: string, bytes: Buffer, contentType: string) => putCrmObject(key, bytes, contentType),
};

export type PreparedPdf = {
  name: string; bytes: Buffer; report: { missingFields: string[]; emptyValues: string[] };
  /** The dealership's child order this form is for; null = the order's one form (one dealership, or combined). */
  dealershipOrderId: string | null; dealershipName: string | null;
};

export type PreparedRequest = {
  method: RequestMethod; kind: FeedKind; subject: string; bodyHtml: string; templateSource: string;
  to: { email: string; name: string | null }[]; cc: { email: string; name: string | null }[];
  pdfs: PreparedPdf[];
  context: TemplateContext; problems: string[];
};

/** What "Send request" would send (the review slide-over shows it rendered). */
export async function prepareRequest(admin: Admin, order: any): Promise<PreparedRequest> {
  if (order.parent_order_id) order = await loadOrder(admin, order.parent_order_id);
  const settings = (await supplierSettings(admin, order.supplier_company_id)) ?? DEFAULT_SETTINGS("");
  const method = settings.request_method;
  const kind: FeedKind = method === "pdf" ? "request_pdf" : "request";
  const tpl = await resolveFeedTemplate(admin, kind, order.supplier_company_id);
  const context = await orderTemplateContext(admin, order);
  const kids = await orderDealerships(admin, order, { open: true });
  const problems = missingInfo(order, method, settings.extra_fields, kids.map((k) => ({ name: k.name, fields: k.order.supplier_fields }))).map((m) => (/^[a-z]/.test(m) ? `Missing ${m}` : m));
  if (!kids.length) problems.push("The order has no dealerships left");
  if (method !== "api" && !settings.request_email) problems.push("The supplier has no request email on its Settings tab");
  const pdfs: PreparedPdf[] = [];
  if (method === "pdf") {
    if (!settings.pdf_template_s3_key) problems.push("The supplier has no PDF template uploaded");
    else {
      const { buildTemplateContext } = await import("../email-compose");
      const template = await feedIo.getObject(settings.pdf_template_s3_key);
      const staffId = order.owner_staff_id ?? order.initiated_by_staff_id ?? "";
      // One form per dealership (filled with that rooftop's details and answers), or one for all of them —
      // the combined form takes the first ticked rooftop's address / phone (not the group's), named for every rooftop.
      const perRoof = kids.length > 1 && order.pdf_mode !== "combined";
      const forms = perRoof ? kids.map((k) => ({ k, companyId: k.companyId })) : [{ k: null as Dealership | null, companyId: kids[0]?.companyId ?? order.dealer_company_id }];
      for (const f of forms) {
        const ctx: TemplateContext = { ...(await buildTemplateContext({ companyId: f.companyId, staffId }, admin)), ...(f.k ? await orderTemplateContext(admin, order, { dealership: f.k.order }) : context) };
        if (!f.k && kids.length > 1) ctx["company.name"] = context["order.dealerships"];   // the combined form names every rooftop
        const filled = await fillRequestPdf(template, settings.pdf_field_map, ctx);
        pdfs.push({
          name: `Feed authorization ${orderNumber(order.id)}${f.k ? ` - ${f.k.name.replace(/[^\w .&'-]+/g, "")}` : ""}.pdf`, bytes: filled.bytes,
          report: { missingFields: filled.missingFields, emptyValues: filled.emptyValues }, dealershipOrderId: f.k?.order.id ?? null, dealershipName: f.k?.name ?? null,
        });
        if (filled.missingFields.length && !problems.some((p) => p.startsWith("PDF fields"))) problems.push(`PDF fields not in the template: ${filled.missingFields.join(", ")}`);
      }
    }
  }
  const to = order.approver_email ? [{ email: order.approver_email, name: order.approver_name }] : [];
  // PDF suppliers get the SIGNED form later (Forward to supplier), not the blank request.
  const cc = method === "pdf" ? [] : [settings.request_email, ...settings.cc_emails].map((e) => normEmail(e)).filter((e): e is string => !!e).map((email) => ({ email, name: null }));
  return { method, kind, subject: tpl.subject, bodyHtml: tpl.body_html, templateSource: tpl.source, to, cc, pdfs, context, problems };
}

/**
 * Send (or re-send) the request from feeds@. `override` = the subject / body
 * staff edited in the review slide-over. Portal / API suppliers: "Mark as
 * sent" (no email). Re-send starts a new thread (e.g. after fixing the approver).
 */
export async function sendRequest(admin: Admin, orderId: string, staffId: string, opts: { resend?: boolean; override?: { subject?: string; bodyHtml?: string } } = {}): Promise<any> {
  const order = await loadParent(admin, orderId);
  const prep = await prepareRequest(admin, order);
  const evType = opts.resend ? "resent" : "request_sent";
  if (prep.method === "api") return applyOrderEvent(admin, order.id, { type: evType, threadId: null } as OrderEvent, staffId, { note: "Marked as sent (supplier portal)" });
  if (prep.problems.length) throw new FeedOrderError(400, prep.problems.join(". "));
  const mb = await feedsMailbox(admin);
  const { emailId, threadId } = await feedIo.send({
    staffId, mode: "new", mailboxId: mb.id, companyId: order.dealer_company_id,
    to: prep.to, cc: prep.cc, subject: opts.override?.subject ?? prep.subject, bodyHtml: opts.override?.bodyHtml ?? prep.bodyHtml,
    templateContext: prep.context,
    attachments: prep.pdfs.map((p) => ({ name: p.name, contentType: "application/pdf", bytes: p.bytes })),
  }, admin);
  for (const p of prep.pdfs) await storeOrderPdf(admin, p.dealershipOrderId ? await loadOrder(admin, p.dealershipOrderId) : order, p.name, p.bytes, "pdf_s3_key", staffId);
  if (threadId) {
    await admin.from("crm_email_threads").update({ company_id: order.dealer_company_id, matched_by: "manual", match_candidates: [] }).eq("id", threadId).is("company_id", null);
    await relinkThreadActivities(admin, threadId, order.dealer_company_id, null);
    await linkThread(admin, threadId, order.id);
  }
  return applyOrderEvent(admin, order.id, { type: evType, threadId } as OrderEvent, staffId, { email_id: emailId, thread_id: threadId });
}

/** Store a PDF on `order` (the parent, or a dealership's child — its own company's Files). */
export async function storeOrderPdf(admin: Admin, order: any, filename: string, bytes: Buffer, column: "pdf_s3_key" | "signed_pdf_s3_key", staffId: string | null): Promise<string> {
  const id = randomUUID();
  const safe = filename.replace(/[^\w.\- ()&']+/g, "_").slice(0, 120);
  const key = `crm/${order.dealer_company_id}/files/${id}/${safe}`;
  await feedIo.putObject(key, bytes, "application/pdf");
  await admin.from("crm_company_files").insert({ id, company_id: order.dealer_company_id, filename: safe, content_type: "application/pdf", size: bytes.length, s3_key: key, label: column === "signed_pdf_s3_key" ? "Signed feed authorization" : "Feed authorization", uploaded_by: staffId });
  await admin.from("crm_feed_orders").update({ [column]: key }).eq("id", order.id);
  return key;
}

/** Every signed form on the order: the order's own (one dealership / combined) + each dealership's. */
async function signedPdfs(admin: Admin, parent: any): Promise<{ key: string; name: string | null }[]> {
  const kids = await orderDealerships(admin, parent, { open: true });
  return [
    ...(parent.signed_pdf_s3_key ? [{ key: parent.signed_pdf_s3_key, name: null }] : []),
    ...kids.filter((k) => k.order.signed_pdf_s3_key).map((k) => ({ key: k.order.signed_pdf_s3_key, name: k.name })),
  ];
}

/** Signed PDF(s) → the supplier, one new email (suppliers that need it from us). */
export async function forwardSignedPdf(admin: Admin, orderId: string, staffId: string): Promise<{ missing: string[] }> {
  const order = await loadParent(admin, orderId);
  const forms = await signedPdfs(admin, order);
  if (!forms.length) throw new FeedOrderError(400, "Upload the signed PDF first");
  const settings = await supplierSettings(admin, order.supplier_company_id);
  if (!settings?.request_email) throw new FeedOrderError(400, "The supplier has no request email");
  const kids = await orderDealerships(admin, order, { open: true });
  // Per-rooftop forms: name the dealerships still without one (staff may forward the rest now).
  const missing = kids.length > 1 && order.pdf_mode !== "combined" && !order.signed_pdf_s3_key ? kids.filter((k) => !k.order.signed_pdf_s3_key).map((k) => k.name) : [];
  const ctx = await orderTemplateContext(admin, order);
  // A new email to the supplier only — not a reply-all on the dealer's thread (the supplier's
  // "Signed PDF to supplier" template; Autosoft's is its own "Activation Rqst" wording).
  const tpl = await resolveFeedTemplate(admin, "supplier_forward", order.supplier_company_id);
  const att = [];
  for (const f of forms) att.push({ name: `Signed feed authorization ${orderNumber(order.id)}${f.name ? ` - ${f.name.replace(/[^\w .&'-]+/g, "")}` : ""}.pdf`, contentType: "application/pdf", bytes: await feedIo.getObject(f.key) });
  const mb = await feedsMailbox(admin);
  const r = await feedIo.send({ staffId, mode: "new", mailboxId: mb.id, companyId: order.dealer_company_id, to: [{ email: settings.request_email, name: null }], cc: settings.cc_emails.map((email) => ({ email })), subject: tpl.subject, bodyHtml: tpl.body_html, attachments: att, templateContext: ctx }, admin);
  await linkThread(admin, r.threadId ?? null, order.id);
  await admin.from("crm_tasks").update({ status: "done", completed_at: new Date().toISOString() }).eq("feed_order_id", order.id).eq("kind", "feed_forward_signed_pdf").eq("status", "open");
  await recordEvent(admin, order, "signed_pdf_forwarded", { note: `${forms.length} signed PDF${forms.length === 1 ? "" : "s"} forwarded to ${settings.request_email}${missing.length ? ` — still none for ${joinNames(missing)}` : ""}`, thread_id: r.threadId ?? null }, staffId);
  return { missing };
}

/**
 * A dealer's reply on the order carrying PDFs = the signed authorization(s) (pdf suppliers). One
 * dealership (or a combined form): the best-named PDF becomes the order's signed PDF. Several
 * with one form each: each PDF goes to the dealership its filename names (or its account);
 * ones that can't be placed are listed on the task. Each lands in that dealership's Files and
 * "Signed form received — forward to {supplier}" goes to the owner. Null = no stored PDF.
 */
export async function attachSignedPdfFromEmail(admin: Admin, order: any, emailId: string, supplierName: string | null): Promise<{ filename: string; others: string[]; placed: { dealership: string; filename: string }[] } | null> {
  const { data: atts } = await admin.from("crm_email_attachments").select("id, filename, content_type, size, s3_key, is_inline").eq("email_id", emailId);
  const pdfs = (atts ?? []).filter((a: any) => !a.is_inline && a.s3_key && (/pdf/i.test(a.content_type ?? "") || /\.pdf$/i.test(a.filename ?? "")));
  if (!pdfs.length) return null;
  const settings = await supplierSettings(admin, order.supplier_company_id);
  const idField = feedIdField(settings?.extra_fields ?? []);
  const kids = await orderDealerships(admin, order, { open: true });
  const file = async (companyId: string, a: any) => admin.from("crm_company_files").insert({ company_id: companyId, filename: a.filename, content_type: "application/pdf", size: a.size ?? null, s3_key: a.s3_key, label: "Signed feed authorization", uploaded_by: null });
  const placed: { dealership: string; filename: string }[] = [];
  let primary: any, others: string[];
  if (kids.length > 1 && order.pdf_mode !== "combined") {
    const map = matchPdfsToDealerships(pdfs.map((a: any) => a.filename), kids.map((k) => ({ id: k.order.id, name: k.name, account: idField ? k.order.supplier_fields?.[idField.key] ?? null : null })));
    for (const k of kids) {
      const i = map.byDealership[k.order.id];
      if (i == null) continue;
      await admin.from("crm_feed_orders").update({ signed_pdf_s3_key: pdfs[i].s3_key }).eq("id", k.order.id);
      await file(k.companyId, pdfs[i]);
      placed.push({ dealership: k.name, filename: pdfs[i].filename });
    }
    others = map.unplaced.map((i) => pdfs[i].filename);
    primary = placed.length ? pdfs.find((a: any) => a.filename === placed[0].filename) : pdfs[map.unplaced[0]];
    if (!placed.length && primary) {   // nothing could be placed: keep the first on the order so Forward still has it
      await admin.from("crm_feed_orders").update({ signed_pdf_s3_key: primary.s3_key }).eq("id", order.id);
      await file(order.dealer_company_id, primary);
    }
  } else {
    const names = kids.map((k) => ({ id: k.order.id, name: k.name, account: idField ? k.order.supplier_fields?.[idField.key] ?? null : null }));
    const best = names.length ? matchPdfsToDealerships(pdfs.map((a: any) => a.filename), names).best : 0;
    primary = pdfs[best ?? 0];
    others = pdfs.filter((a: any) => a !== primary).map((a: any) => a.filename);
    await admin.from("crm_feed_orders").update({ signed_pdf_s3_key: primary.s3_key }).eq("id", order.id);
    await file(kids.length === 1 ? kids[0].companyId : order.dealer_company_id, primary);
  }
  const missing = kids.length > 1 && order.pdf_mode !== "combined" ? kids.filter((k) => !placed.some((p) => p.dealership === k.name)).map((k) => k.name) : [];
  await createOrderTask(admin, order, {
    kind: "feed_forward_signed_pdf", title: `Signed form${placed.length > 1 ? "s" : ""} received — forward to ${supplierName ?? "the supplier"}`,
    description: [
      placed.length ? placed.map((p) => `${p.dealership}: ${p.filename}`).join("; ") + "." : `${primary.filename}.`,
      others.length ? `Also attached: ${others.join(", ")} — check which dealership ${others.length === 1 ? "it is" : "they are"} for.` : "",
      missing.length ? `No signed form yet for ${joinNames(missing)}.` : "",
      "Check each is signed and dated, then Forward to supplier.",
    ].filter(Boolean).join(" "),
  }, SYSTEM);
  return { filename: primary.filename, others, placed };
}

async function latestThreadEmail(admin: Admin, threadId: string | null): Promise<any | null> {
  if (!threadId) return null;
  const { data } = await admin.from("crm_emails").select("id, subject, direction, from_email").eq("thread_id", threadId).order("received_at", { ascending: false }).limit(1).maybeSingle();
  return data ?? null;
}

/**
 * Follow-up on the order's thread (reply all keeps the supplier copied).
 * `opts.replyToEmailId`: answer THAT message (reply all) — the supplier's own approval email when it
 * sets a cancellation deadline, so the dealer's Reply All lands in the supplier's case. Suppliers
 * with followup_new_thread (vAuto: closed cases ignore replies) get a fresh email instead.
 */
export async function nudge(admin: Admin, orderId: string, target: "dealer" | "supplier", actor: string, manual: boolean, opts: { replyToEmailId?: string } = {}): Promise<any> {
  const order = await loadParent(admin, orderId);
  const staffId = actor !== SYSTEM ? actor : order.owner_staff_id ?? order.initiated_by_staff_id;
  if (!staffId) throw new FeedOrderError(400, "The order has no owner to send the follow-up as");
  const kind: FeedKind = target === "dealer" ? "dealer_followup" : "supplier_followup";
  // Check the transition first so a nudge never goes out for the wrong state.
  advanceOrder(order, { type: "nudged", target, manual }, { method: null });
  const tpl = await resolveFeedTemplate(admin, kind, order.supplier_company_id);
  const ctx = await orderTemplateContext(admin, order);
  const latest = await latestThreadEmail(admin, order.email_thread_id);
  const settings = await supplierSettings(admin, order.supplier_company_id);
  const supplierRcpts = [settings?.request_email, ...(settings?.cc_emails ?? [])].map((e) => normEmail(e)).filter((e): e is string => !!e).map((email) => ({ email }));
  const approver = order.approver_email ? [{ email: order.approver_email, name: order.approver_name }] : [];
  const to = target === "dealer" ? approver : supplierRcpts;
  const cc = target === "dealer" ? supplierRcpts : approver;
  if (!to.length) throw new FeedOrderError(400, target === "dealer" ? "No approver email on the order" : "The supplier has no request email");
  const replyTo = opts.replyToEmailId ? (await admin.from("crm_emails").select("id, subject").eq("id", opts.replyToEmailId).maybeSingle()).data : null;
  const fresh = target === "supplier" && !!settings?.followup_new_thread;
  if (replyTo && !fresh) {
    await feedIo.send({ staffId, mode: "replyAll", emailId: replyTo.id, to, cc, subject: `RE: ${(replyTo.subject ?? "").replace(/^\s*(re:\s*)+/i, "")}`, bodyHtml: tpl.body_html, templateContext: ctx }, admin);
  } else if (latest && !fresh) {
    await feedIo.send({ staffId, mode: "replyAll", emailId: latest.id, to, cc, subject: `RE: ${(latest.subject ?? "").replace(/^\s*(re:\s*)+/i, "")}`, bodyHtml: tpl.body_html, templateContext: ctx }, admin);
  } else {
    const mb = await feedsMailbox(admin);
    // vAuto's follow-up goes to the supplier alone, as a new case-quoting email; the order keeps its thread.
    const r = await feedIo.send({ staffId, mode: "new", mailboxId: mb.id, companyId: order.dealer_company_id, to, cc: fresh ? [] : cc, subject: tpl.subject, bodyHtml: tpl.body_html, templateContext: ctx }, admin);
    if (r.threadId && !order.email_thread_id) await admin.from("crm_feed_orders").update({ email_thread_id: r.threadId }).eq("id", order.id);
    await linkThread(admin, r.threadId ?? null, order.id);
  }
  return applyOrderEvent(admin, order.id, { type: "nudged", target, manual }, actor);
}

// ── Feed ID (per dealership) ─────────────────────────────────────────────────

/**
 * The dealership a Feed ID action is for: a child id as is; a parent id only when the order has
 * exactly one open dealership (else staff must pick).
 */
export async function resolveDealership(admin: Admin, orderId: string, dealershipOrderId?: string | null): Promise<any> {
  const o = await loadOrder(admin, dealershipOrderId ?? orderId);
  if (o.parent_order_id) {
    if (dealershipOrderId && o.parent_order_id !== orderId && o.id !== orderId) throw new FeedOrderError(400, "That dealership isn't on this order");
    return o;
  }
  const kids = await orderDealerships(admin, o, { open: true });
  if (kids.length === 1) return kids[0].order;
  throw new FeedOrderError(400, kids.length ? "Pick which dealership this Feed ID is for" : "The order has no open dealerships");
}

export async function enterFeedId(admin: Admin, orderId: string, candidate: string, actor: string, dealershipOrderId?: string | null): Promise<any> {
  const kid = await resolveDealership(admin, orderId, dealershipOrderId);
  const o = await applyOrderEvent(admin, kid.id, { type: "feed_id_entered", candidate }, actor, { candidate });
  await createOrderTask(admin, o, { kind: "feed_confirm_id", title: `Confirm Feed ID ${o.feed_id_candidate}`, assignee: o.owner_staff_id }, actor);
  return o;
}

/**
 * Confirm a dealership's Feed ID: write the provider + Feed ID to that dealer
 * through the platform's own service (lib/dealer-feed-id.ts — cascade,
 * feed-aware inventory handling, HubSpot, admin_audit), the dealership →
 * assigned (→ done once its first import lands; see checkImport). The order
 * goes done when every dealership is assigned or cancelled; the approver hears
 * once every dealership is live (notifyLive).
 */
export async function confirmFeedId(admin: Admin, orderId: string, feedId: string, staffId: string, dealershipOrderId?: string | null): Promise<any> {
  const kid = await resolveDealership(admin, orderId, dealershipOrderId);
  const parent = await loadOrder(admin, kid.parent_order_id);
  const id = feedId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,60}$/.test(id)) throw new FeedOrderError(400, "Feed IDs are letters, numbers, dots, dashes or underscores");
  advanceOrder(kid, { type: "feed_id_confirmed", feedId: id, staffId }, { method: null });   // validate before writing anything
  const { data: siblings } = await admin.from("crm_feed_orders").select("id, feed_id_confirmed").eq("parent_order_id", parent.id).neq("id", kid.id);
  if ((siblings ?? []).some((s: any) => s.feed_id_confirmed === id)) throw new FeedOrderError(409, `Feed ID ${id} is already assigned to another dealership on this order`);
  const { data: co } = await admin.from("crm_companies").select("dealer_id").eq("id", kid.dealer_company_id).single();
  const { data: dealer } = await admin.from("dealers").select("id, dealer_id, inventory_dealer_id, name").eq("id", co.dealer_id).single();
  const settings = await supplierSettings(admin, parent.supplier_company_id);
  const { data: sup } = parent.supplier_company_id ? await admin.from("crm_company_directory").select("name").eq("id", parent.supplier_company_id).maybeSingle() : { data: null };

  if (dealer.inventory_dealer_id !== id) {
    const { data: clash } = await admin.from("dealers").select("name").neq("id", dealer.id).or(`dealer_id.eq.${id},inventory_dealer_id.eq.${id}`).limit(1);
    if (clash?.length) throw new FeedOrderError(409, `Feed ID ${id} is already used by ${clash[0].name} — check it with the supplier`);
    try {
      await applyFeedIdChange(admin, dealer, id, await activeVehicleCount(admin, dealer.dealer_id), staffId);
    } catch (e) {
      if (e instanceof FeedIdChangeError) throw new FeedOrderError(e.status, e.message);
      throw e;
    }
  }
  const provider = settings?.platform_provider ?? sup?.name ?? null;
  if (provider) {
    await admin.from("dealers").update({ inventory_provider: provider, inventory_provider_is_dms: !!settings?.is_dms }).eq("id", dealer.id);
    fireDealerSync(dealer.id);
    fireWrite(admin.from("admin_audit").insert({ admin_user_id: staffId, action: "inventory_provider_changed", target_dealer_id: dealer.dealer_id, metadata: { via: "crm_feed_order", order_id: parent.id, dealership_order_id: kid.id, provider, is_dms: !!settings?.is_dms } }), "admin_audit");
  }
  let updated = await applyOrderEvent(admin, kid.id, { type: "feed_id_confirmed", feedId: id, staffId }, staffId, { feed_id: id, provider });
  updated = (await checkImport(admin, updated)) ?? updated;
  await notifyLive(admin, parent.id, staffId);
  return updated;
}

/**
 * The "feed is set up" email to the approver (from feeds@, a new thread) — at most two per order:
 *   final   — once no dealership is still waiting (each one assigned / done, or dropped): every live
 *             store with its Feed ID. One dealership = this email at confirm, as before.
 *   partial — only from the stall job (`partial: true`), when some dealerships are still unconfirmed
 *             2 business days after the first confirmation: the live stores and the pending ones.
 * Each is claimed on the parent (live_partial_notified_at / live_notified_at) before sending, so two
 * confirmations at once can't both send; a failed send releases the claim and leaves a task.
 */
export async function notifyLive(admin: Admin, orderId: string, staffId: string, opts: { partial?: boolean; now?: Date } = {}): Promise<"final" | "partial" | null> {
  const parent = await loadParent(admin, orderId);
  if (!parent.approver_email || parent.live_notified_at) return null;
  const kids = await orderDealerships(admin, parent, { open: true });
  const live = kids.filter((k) => k.order.feed_id_confirmed && (k.order.status === "assigned" || k.order.status === "done"));
  const pending = kids.filter((k) => !live.includes(k));
  if (!live.length) return null;
  let which: "final" | "partial" = "final";
  if (pending.length) {
    if (!opts.partial || parent.live_partial_notified_at) return null;
    const first = live.map((k) => k.order.assigned_at).filter(Boolean).sort()[0];
    if (!first || businessDaysBetween(first, opts.now ?? new Date()) < 2) return null;
    which = "partial";
  }
  const col = which === "final" ? "live_notified_at" : "live_partial_notified_at";
  const { data: claimed } = await admin.from("crm_feed_orders").update({ [col]: new Date().toISOString() }).eq("id", parent.id).is(col, null).select("id");
  if (!claimed?.length) return null;
  const names = (ks: Dealership[]) => joinNames(ks.map((k) => k.name));
  try {
    const mb = await feedsMailbox(admin);
    const tpl = await resolveFeedTemplate(admin, which === "final" ? "feed_assigned" : "feed_assigned_partial", parent.supplier_company_id);
    const templateContext: TemplateContext = {
      ...(await orderTemplateContext(admin, parent)),
      "order.dealerships": names(kids), "order.feed_id": live.map((k) => k.order.feed_id_confirmed).join("/"),
      "order.live_dealerships": names(live), "order.pending_dealerships": pending.length ? names(pending) : null,
      "order.feed_id_list": live.map((k) => `${k.name} — feed ID ${k.order.feed_id_confirmed}`).join("\n"),
    };
    await feedIo.send({ staffId, mode: "new", mailboxId: mb.id, companyId: parent.dealer_company_id, to: [{ email: parent.approver_email, name: parent.approver_name }], subject: tpl.subject, bodyHtml: tpl.body_html, templateContext }, admin);
  } catch (e) {
    await admin.from("crm_feed_orders").update({ [col]: null }).eq("id", parent.id);
    await createOrderTask(admin, parent, { kind: "feed_notify_dealer", title: `Tell the dealer ${names(live)} ${live.length > 1 ? "are" : "is"} set up (the email didn't send)`, description: e instanceof Error ? e.message : String(e) }, SYSTEM);
    return null;
  }
  await recordEvent(admin, parent, "dealer_notified", { note: which === "final" ? `Told ${parent.approver_email}: ${names(live)} live` : `Told ${parent.approver_email}: ${names(live)} live, still waiting on ${names(pending)}` }, staffId);
  return which;
}

/** A dealership assigned → done once it has feed-owned vehicles (the platform's feed status). */
export async function checkImport(admin: Admin, order: any): Promise<any | null> {
  if (order.status !== "assigned" || !order.parent_order_id) return null;
  const { data: co } = await admin.from("crm_companies").select("dealer_id").eq("id", order.dealer_company_id).single();
  const { data: dealer } = await admin.from("dealers").select("dealer_id, inventory_dealer_id").eq("id", co.dealer_id).single();
  const st = await getDealerFeedStatus(admin, dealer.dealer_id, dealer.inventory_dealer_id);
  if (st.signals.feedOwnedVehicles > 0) return applyOrderEvent(admin, order.id, { type: "import_succeeded", via: "feed_status" }, SYSTEM, { note: `${st.signals.feedOwnedVehicles} feed vehicles imported` });
  return null;
}

// ── Simple actions ───────────────────────────────────────────────────────────

export const markDealerApproved = async (admin: Admin, id: string, staffId: string, note?: string) =>
  applyOrderEvent(admin, (await loadParent(admin, id)).id, { type: "dealer_approved", via: "phone" }, staffId, { via: "phone", note: note ?? "Approved by phone" });

/** Cancel the order (every open dealership with it), or — given a dealership's child id — just that dealership. */
export async function cancelOrder(admin: Admin, id: string, reason: string, staffId: string): Promise<any> {
  const o = await loadOrder(admin, id);
  if (o.parent_order_id) {
    const dropped = await applyOrderEvent(admin, o.id, { type: "cancelled", reason }, staffId, { reason });
    await notifyLive(admin, o.parent_order_id, staffId);   // the rest may all be live now
    return dropped;
  }
  // The order first (its reason, not the "every dealership cancelled" rollup), then its open dealerships.
  const cancelled = await applyOrderEvent(admin, o.id, { type: "cancelled", reason }, staffId, { reason });
  for (const k of await orderDealerships(admin, o)) {
    if (isOpen(k.order.status)) await applyOrderEvent(admin, k.order.id, { type: "cancelled", reason }, staffId, { reason }).catch((e) => { if (!(e instanceof TransitionError)) throw e; });
  }
  return cancelled;
}

export async function reassignOwner(admin: Admin, id: string, ownerId: string | null, staffId: string): Promise<any> {
  const parent = await loadParent(admin, id);
  const o = await applyOrderEvent(admin, parent.id, { type: "owner_changed", ownerId }, staffId);
  const kids = await orderDealerships(admin, parent);
  await admin.from("crm_feed_orders").update({ owner_staff_id: ownerId }).eq("parent_order_id", parent.id);
  if (ownerId) {
    for (const oid of [parent.id, ...kids.map((k) => k.order.id)]) await admin.from("crm_tasks").update({ assigned_staff_id: ownerId }).eq("feed_order_id", oid).eq("status", "open").is("assigned_capability", null);
  }
  return o;
}

export { hasRequiredInfo, STATUS_LABEL, TransitionError, isOpen };

export function adminClient(): Admin { return createAdminSupabaseClient(); }
