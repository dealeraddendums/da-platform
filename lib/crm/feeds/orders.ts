// DA-CRM feed orders — the service every entry point uses (rail / queue / order
// slide-over APIs, the self-serve hook, the feeds@ inbound handler, the daily
// stall job). Status only changes through applyOrderEvent() → advanceOrder()
// (state.ts); each change is a crm_feed_order_events row and a 'feed_order'
// activity on the dealer's timeline. Mail goes out from feeds@ through the
// Inbox send path (lib/crm/inbox-send.ts → composeEmail()).
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
import { nextBusinessDayDue } from "../business-days";
import { sendInboxEmail } from "../inbox-send";
import { relinkThreadActivities } from "../inbox-ingest";
import { putCrmObject } from "../recordings";
import { FREEMAIL_DOMAINS, normEmail } from "../inbox-match";
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
};

export const DEFAULT_SETTINGS = (companyId: string): SupplierSettings => ({
  company_id: companyId, request_method: "email", request_email: null, cc_emails: [], pdf_template_s3_key: null, pdf_field_map: {},
  feed_id_pattern: null, typical_turnaround_days: 2, platform_provider: null, is_dms: false, needs_review: true, notes: null,
});

export async function supplierSettings(admin: Admin, companyId: string | null): Promise<SupplierSettings | null> {
  if (!companyId) return null;
  const { data } = await admin.from("crm_feed_supplier_settings").select("*").eq("company_id", companyId).maybeSingle();
  return data ? { ...data, cc_emails: Array.isArray(data.cc_emails) ? data.cc_emails : [] } : DEFAULT_SETTINGS(companyId);
}

export async function loadOrder(admin: Admin, id: string): Promise<any> {
  const { data } = await admin.from("crm_feed_orders").select("*").eq("id", id).maybeSingle();
  if (!data) throw new FeedOrderError(404, "Feed order not found");
  return data;
}

// ── Events + timeline ────────────────────────────────────────────────────────

const EVENT_TEXT: Record<string, string> = {
  created: "Feed order started", info_updated: "Order details updated", request_sent: "Feed request sent",
  resent: "Feed request re-sent", dealer_approved: "Dealer approved", supplier_replied: "Supplier replied",
  feed_id_detected: "Feed ID received", feed_id_entered: "Feed ID entered", feed_id_confirmed: "Feed ID confirmed and assigned",
  import_succeeded: "First feed import — order done", nudged: "Follow-up sent", owner_changed: "Owner changed", cancelled: "Feed order cancelled",
  task_created: "Task created", signed_pdf_forwarded: "Signed PDF forwarded to the supplier", signed_pdf_uploaded: "Signed PDF uploaded", unmatched_linked: "Email linked to the order", review: "Reply needs review",
};

export async function recordEvent(admin: Admin, order: any, type: string, detail: Record<string, unknown>, actor: string): Promise<void> {
  const at = new Date().toISOString();
  const { error } = await admin.from("crm_feed_order_events").insert({ order_id: order.id, type, detail, actor, occurred_at: at });
  if (error) console.error(`[crm-feeds] event ${order.id} ${type}: ${error.message}`);
  const { error: aErr } = await admin.from("crm_activities").insert({
    company_id: order.dealer_company_id, type: "feed_order", direction: "internal",
    subject: `${EVENT_TEXT[type] ?? type} · ${orderNumber(order.id)}`,
    body: typeof detail.note === "string" ? detail.note : typeof detail.reason === "string" ? detail.reason : null,
    metadata: { feed_order_id: order.id, event: type, status: order.status, ...pick(detail, ["feed_id", "candidate", "target", "via", "email_id", "thread_id"]) },
    occurred_at: at, actor_staff_id: actor === SYSTEM ? null : actor,
  });
  if (aErr) console.error(`[crm-feeds] activity ${order.id} ${type}: ${aErr.message}`);
}

const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => o[k] != null).map((k) => [k, o[k]]));

/** The only status writer: advanceOrder() + a guarded update + the event. */
export async function applyOrderEvent(admin: Admin, orderId: string, ev: OrderEvent, actor: string, detail: Record<string, unknown> = {}): Promise<any> {
  const order = await loadOrder(admin, orderId);
  const settings = await supplierSettings(admin, order.supplier_company_id);
  const adv = advanceOrder(order, ev, { method: settings?.request_method ?? null });
  const { data, error } = await admin.from("crm_feed_orders").update(adv.patch).eq("id", orderId).eq("status", order.status).select("*").maybeSingle();
  if (error) throw new FeedOrderError(500, error.message);
  if (!data) throw new FeedOrderError(409, "The order changed while you were working on it — reload and try again");
  await recordEvent(admin, data, ev.type, { ...evDetail(ev), ...detail, from: order.status, to: data.status }, actor);
  if (adv.changed) await onStatusChange(admin, order.status, data);
  return data;
}

function evDetail(ev: OrderEvent): Record<string, unknown> {
  const { type: _t, ...rest } = ev as any;
  return rest;
}

/** Close tasks that no longer apply once the order moves on. */
async function onStatusChange(admin: Admin, from: OrderStatus, order: any): Promise<void> {
  const done: Record<string, string[]> = {
    ready: ["feed_get_info"], awaiting_dealer_approval: ["feed_get_info"],
    awaiting_supplier: ["feed_get_info", "feed_call_approver", "feed_review_dealer_reply"],
    feed_id_received: ["feed_call_supplier", "feed_call_approver", "feed_enter_feed_id"],
    assigned: ["feed_confirm_id", "feed_enter_feed_id", "feed_call_supplier"],
  };
  const kinds = order.status === "cancelled" || order.status === "done" ? null : done[order.status];
  let q = admin.from("crm_tasks").update({ status: "done", completed_at: new Date().toISOString() }).eq("feed_order_id", order.id).eq("status", "open");
  if (kinds) q = q.in("kind", kinds);
  if (kinds || !isOpen(order.status)) await q;
  void from;
}

// ── Tasks ────────────────────────────────────────────────────────────────────

export async function createOrderTask(admin: Admin, order: any, t: { kind: string; title: string; description?: string | null; assignee?: string | null; due?: string | null; capability?: string | null }, actor: string): Promise<string | null> {
  // One open task per kind per order.
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
  const { data: open } = await admin.from("crm_feed_orders").select("owner_staff_id").in("owner_staff_id", ids).not("status", "in", "(done,cancelled)");
  const load = Object.fromEntries(ids.map((id) => [id, 0]));
  for (const o of open ?? []) load[o.owner_staff_id] = (load[o.owner_staff_id] ?? 0) + 1;
  return ids.sort((a, b) => load[a] - load[b] || a.localeCompare(b))[0];
}

// ── Create / update ──────────────────────────────────────────────────────────

export type CreateInput = {
  dealerCompanyId: string; supplierCompanyId?: string | null; source: "call" | "chat" | "email" | "self_serve";
  initiatedBy?: string | null; ownerId?: string | null; approverName?: string | null; approverEmail?: string | null; approverPhone?: string | null;
  notes?: string | null; emailThreadId?: string | null;
};

export async function createFeedOrder(admin: Admin, input: CreateInput): Promise<{ order: any; existed: boolean }> {
  const { data: dealer } = await admin.from("crm_companies").select("id, kind").eq("id", input.dealerCompanyId).maybeSingle();
  if (!dealer || dealer.kind !== "dealer") throw new FeedOrderError(400, "Feed orders are for dealers");
  if (input.supplierCompanyId) {
    const { data: s } = await admin.from("crm_companies").select("kind").eq("id", input.supplierCompanyId).maybeSingle();
    if (s?.kind !== "feed_supplier") throw new FeedOrderError(400, "That company isn't a feed supplier");
  }
  const { data: existing } = await admin.from("crm_feed_orders").select("*").eq("dealer_company_id", input.dealerCompanyId).not("status", "in", "(done,cancelled)").maybeSingle();
  if (existing) {
    // Fill gaps from the new request (never overwrite what staff already have).
    const fill: Record<string, unknown> = {};
    if (!existing.supplier_company_id && input.supplierCompanyId) fill.supplier_company_id = input.supplierCompanyId;
    if (!existing.approver_email && input.approverEmail) fill.approver_email = normEmail(input.approverEmail);
    if (!existing.approver_name && input.approverName) fill.approver_name = input.approverName.trim();
    if (!existing.approver_phone && input.approverPhone) fill.approver_phone = input.approverPhone.trim();
    if (Object.keys(fill).length && ["needs_info", "ready"].includes(existing.status)) {
      return { order: await applyOrderEvent(admin, existing.id, { type: "info_updated", fields: fill as any }, input.initiatedBy ?? SYSTEM, { note: `Details added (${input.source})` }), existed: true };
    }
    if (input.emailThreadId && !existing.email_thread_id) await admin.from("crm_feed_orders").update({ email_thread_id: input.emailThreadId }).eq("id", existing.id);
    return { order: existing, existed: true };
  }

  const owner = await resolveOwner(admin, input.dealerCompanyId, input.ownerId ?? input.initiatedBy ?? null);
  const settings = await supplierSettings(admin, input.supplierCompanyId ?? null);
  const base = {
    status: "needs_info" as OrderStatus, supplier_company_id: input.supplierCompanyId ?? null,
    approver_name: input.approverName?.trim() || null, approver_email: normEmail(input.approverEmail) ?? null,
  };
  const adv = advanceOrder(base, { type: "created" }, { method: settings?.request_method ?? null });
  const { data: order, error } = await admin.from("crm_feed_orders").insert({
    ...base, ...adv.patch, dealer_company_id: input.dealerCompanyId, source: input.source,
    initiated_by_staff_id: input.initiatedBy ?? null, owner_staff_id: owner, approver_phone: input.approverPhone?.trim() || null,
    notes: input.notes?.trim() || null, email_thread_id: input.emailThreadId ?? null,
  }).select("*").single();
  if (error) {
    if (error.code === "23505") return createFeedOrder(admin, input);   // raced another create — return that one
    throw new FeedOrderError(500, error.message);
  }
  await recordEvent(admin, order, "created", { source: input.source, note: input.notes ?? null }, input.initiatedBy ?? SYSTEM);
  if (order.status === "needs_info") {
    const missing = missingInfo(order, settings?.request_method ?? null);
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

export function missingInfo(o: any, method: RequestMethod | null): string[] {
  const m: string[] = [];
  if (!o.supplier_company_id) m.push("feed provider");
  if (method !== "api") {
    if (!o.approver_name) m.push("approver name");
    if (!o.approver_email) m.push("approver email");
  }
  return m;
}

export async function updateOrderInfo(admin: Admin, orderId: string, fields: { supplier_company_id?: string | null; approver_name?: string | null; approver_email?: string | null; approver_phone?: string | null }, actor: string): Promise<any> {
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
  return applyOrderEvent(admin, orderId, { type: "info_updated", fields: clean as any }, actor);
}

// ── Template context ─────────────────────────────────────────────────────────

const longDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "long", day: "numeric", year: "numeric" }) : null);

export async function orderTemplateContext(admin: Admin, order: any): Promise<TemplateContext> {
  const [{ data: sup }, settings, { data: co }] = await Promise.all([
    order.supplier_company_id ? admin.from("crm_company_directory").select("name").eq("id", order.supplier_company_id).maybeSingle() : Promise.resolve({ data: null }),
    supplierSettings(admin, order.supplier_company_id),
    admin.from("crm_companies").select("dealer_id").eq("id", order.dealer_company_id).maybeSingle(),
  ]);
  const { data: dealer } = co?.dealer_id ? await admin.from("dealers").select("inventory_provider, inventory_provider_is_dms").eq("id", co.dealer_id).maybeSingle() : { data: null };
  const dms = settings?.is_dms ? (settings.platform_provider ?? sup?.name ?? null) : dealer?.inventory_provider_is_dms ? dealer.inventory_provider : null;
  return {
    "supplier.name": sup?.name ?? null, "supplier.request_email": settings?.request_email ?? null,
    "approver.name": order.approver_name, "approver.first_name": (order.approver_name ?? "").trim().split(/\s+/)[0] || null, "approver.email": order.approver_email,
    "dealer.dms": dms, "order.id": orderNumber(order.id), "order.sent_on": longDate(order.sent_at), "order.feed_id": order.feed_id_confirmed ?? order.feed_id_candidate ?? null,
  };
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

export type PreparedRequest = {
  method: RequestMethod; kind: FeedKind; subject: string; bodyHtml: string; templateSource: string;
  to: { email: string; name: string | null }[]; cc: { email: string; name: string | null }[];
  pdf: { name: string; bytes: Buffer; report: { missingFields: string[]; emptyValues: string[] } } | null;
  context: TemplateContext; problems: string[];
};

/** What "Send request" would send (the review slide-over shows it rendered). */
export async function prepareRequest(admin: Admin, order: any): Promise<PreparedRequest> {
  const settings = (await supplierSettings(admin, order.supplier_company_id)) ?? DEFAULT_SETTINGS("");
  const method = settings.request_method;
  const kind: FeedKind = method === "pdf" ? "request_pdf" : "request";
  const tpl = await resolveFeedTemplate(admin, kind, order.supplier_company_id);
  const context = await orderTemplateContext(admin, order);
  const problems = missingInfo(order, method).map((m) => `Missing ${m}`);
  if (method !== "api" && !settings.request_email) problems.push("The supplier has no request email on its Settings tab");
  let pdf: PreparedRequest["pdf"] = null;
  if (method === "pdf") {
    if (!settings.pdf_template_s3_key) problems.push("The supplier has no PDF template uploaded");
    else {
      const { buildTemplateContext } = await import("../email-compose");
      const ctx = { ...(await buildTemplateContext({ companyId: order.dealer_company_id, staffId: order.owner_staff_id ?? order.initiated_by_staff_id ?? "" }, admin)), ...context };
      const filled = await fillRequestPdf(await getCrmObject(settings.pdf_template_s3_key), settings.pdf_field_map, ctx);
      pdf = { name: `Feed authorization ${orderNumber(order.id)}.pdf`, bytes: filled.bytes, report: { missingFields: filled.missingFields, emptyValues: filled.emptyValues } };
      if (filled.missingFields.length) problems.push(`PDF fields not in the template: ${filled.missingFields.join(", ")}`);
    }
  }
  const to = order.approver_email ? [{ email: order.approver_email, name: order.approver_name }] : [];
  const cc = [settings.request_email, ...settings.cc_emails].map((e) => normEmail(e)).filter((e): e is string => !!e).map((email) => ({ email, name: null }));
  return { method, kind, subject: tpl.subject, bodyHtml: tpl.body_html, templateSource: tpl.source, to, cc, pdf, context, problems };
}

/**
 * Send (or re-send) the request from feeds@. `override` = the subject / body
 * staff edited in the review slide-over. Portal / API suppliers: "Mark as
 * sent" (no email). Re-send starts a new thread (e.g. after fixing the approver).
 */
export async function sendRequest(admin: Admin, orderId: string, staffId: string, opts: { resend?: boolean; override?: { subject?: string; bodyHtml?: string } } = {}): Promise<any> {
  const order = await loadOrder(admin, orderId);
  const prep = await prepareRequest(admin, order);
  const evType = opts.resend ? "resent" : "request_sent";
  if (prep.method === "api") return applyOrderEvent(admin, orderId, { type: evType, threadId: null } as OrderEvent, staffId, { note: "Marked as sent (supplier portal)" });
  if (prep.problems.length) throw new FeedOrderError(400, prep.problems.join(". "));
  const mb = await feedsMailbox(admin);
  const { emailId, threadId } = await sendInboxEmail({
    staffId, mode: "new", mailboxId: mb.id, companyId: order.dealer_company_id,
    to: prep.to, cc: prep.cc, subject: opts.override?.subject ?? prep.subject, bodyHtml: opts.override?.bodyHtml ?? prep.bodyHtml,
    templateContext: prep.context,
    attachments: prep.pdf ? [{ name: prep.pdf.name, contentType: "application/pdf", bytes: prep.pdf.bytes }] : [],
  }, admin);
  if (prep.pdf) await storeOrderPdf(admin, order, prep.pdf.name, prep.pdf.bytes, "pdf_s3_key", staffId);
  if (threadId) {
    await admin.from("crm_email_threads").update({ company_id: order.dealer_company_id, matched_by: "manual", match_candidates: [] }).eq("id", threadId).is("company_id", null);
    await relinkThreadActivities(admin, threadId, order.dealer_company_id, null);
  }
  return applyOrderEvent(admin, orderId, { type: evType, threadId } as OrderEvent, staffId, { email_id: emailId, thread_id: threadId });
}

export async function storeOrderPdf(admin: Admin, order: any, filename: string, bytes: Buffer, column: "pdf_s3_key" | "signed_pdf_s3_key", staffId: string | null): Promise<string> {
  const id = randomUUID();
  const safe = filename.replace(/[^\w.\- ()]+/g, "_").slice(0, 120);
  const key = `crm/${order.dealer_company_id}/files/${id}/${safe}`;
  await putCrmObject(key, bytes, "application/pdf");
  await admin.from("crm_company_files").insert({ id, company_id: order.dealer_company_id, filename: safe, content_type: "application/pdf", size: bytes.length, s3_key: key, label: column === "signed_pdf_s3_key" ? "Signed feed authorization" : "Feed authorization", uploaded_by: staffId });
  await admin.from("crm_feed_orders").update({ [column]: key }).eq("id", order.id);
  return key;
}

/** Signed PDF → the supplier, on the order's thread (suppliers that need it from us). */
export async function forwardSignedPdf(admin: Admin, orderId: string, staffId: string): Promise<void> {
  const order = await loadOrder(admin, orderId);
  if (!order.signed_pdf_s3_key) throw new FeedOrderError(400, "Upload the signed PDF first");
  const settings = await supplierSettings(admin, order.supplier_company_id);
  if (!settings?.request_email) throw new FeedOrderError(400, "The supplier has no request email");
  const latest = await latestThreadEmail(admin, order.email_thread_id);
  const ctx = await orderTemplateContext(admin, order);
  const body = `<p>Hello {{supplier.name}} Support,</p><p>Attached is the signed inventory feed authorization for {{company.name}}. Please send us the Dealer ID once the feed is set up.</p><p>Thank you!</p>`;
  const att = [{ name: `Signed feed authorization ${orderNumber(order.id)}.pdf`, contentType: "application/pdf", bytes: await getCrmObject(order.signed_pdf_s3_key) }];
  const to = [{ email: settings.request_email, name: null }];
  if (latest) await sendInboxEmail({ staffId, mode: "replyAll", emailId: latest.id, to, cc: settings.cc_emails.map((email) => ({ email })), subject: `RE: ${latest.subject ?? ""}`, bodyHtml: body, attachments: att, templateContext: ctx }, admin);
  else {
    const mb = await feedsMailbox(admin);
    await sendInboxEmail({ staffId, mode: "new", mailboxId: mb.id, companyId: order.dealer_company_id, to, subject: "Signed inventory feed authorization: {{company.name}}", bodyHtml: body, attachments: att, templateContext: ctx }, admin);
  }
  await recordEvent(admin, order, "signed_pdf_forwarded", { note: "Signed PDF forwarded to the supplier" }, staffId);
}

async function latestThreadEmail(admin: Admin, threadId: string | null): Promise<any | null> {
  if (!threadId) return null;
  const { data } = await admin.from("crm_emails").select("id, subject, direction, from_email").eq("thread_id", threadId).order("received_at", { ascending: false }).limit(1).maybeSingle();
  return data ?? null;
}

/** Follow-up on the order's thread (reply all keeps the supplier copied). */
export async function nudge(admin: Admin, orderId: string, target: "dealer" | "supplier", actor: string, manual: boolean): Promise<any> {
  const order = await loadOrder(admin, orderId);
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
  if (latest) {
    await sendInboxEmail({ staffId, mode: "replyAll", emailId: latest.id, to, cc, subject: `RE: ${(latest.subject ?? "").replace(/^\s*(re:\s*)+/i, "")}`, bodyHtml: tpl.body_html, templateContext: ctx }, admin);
  } else {
    const mb = await feedsMailbox(admin);
    const r = await sendInboxEmail({ staffId, mode: "new", mailboxId: mb.id, companyId: order.dealer_company_id, to, cc, subject: tpl.subject, bodyHtml: tpl.body_html, templateContext: ctx }, admin);
    if (r.threadId) await admin.from("crm_feed_orders").update({ email_thread_id: r.threadId }).eq("id", order.id);
  }
  return applyOrderEvent(admin, orderId, { type: "nudged", target, manual }, actor);
}

// ── Feed ID ──────────────────────────────────────────────────────────────────

export async function enterFeedId(admin: Admin, orderId: string, candidate: string, actor: string): Promise<any> {
  const o = await applyOrderEvent(admin, orderId, { type: "feed_id_entered", candidate }, actor, { candidate });
  await createOrderTask(admin, o, { kind: "feed_confirm_id", title: `Confirm Feed ID ${o.feed_id_candidate}`, assignee: o.owner_staff_id }, actor);
  return o;
}

/**
 * Confirm Feed ID: write the provider + Feed ID to the dealer through the
 * platform's own service (lib/dealer-feed-id.ts — cascade, feed-aware
 * inventory handling, HubSpot, admin_audit), email the dealer the Feed
 * assigned template from feeds@, status → assigned (→ done once the first
 * import lands; see checkImports).
 */
export async function confirmFeedId(admin: Admin, orderId: string, feedId: string, staffId: string): Promise<any> {
  const order = await loadOrder(admin, orderId);
  const id = feedId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,60}$/.test(id)) throw new FeedOrderError(400, "Feed IDs are letters, numbers, dots, dashes or underscores");
  advanceOrder(order, { type: "feed_id_confirmed", feedId: id, staffId }, { method: null });   // validate before writing anything
  const { data: co } = await admin.from("crm_companies").select("dealer_id").eq("id", order.dealer_company_id).single();
  const { data: dealer } = await admin.from("dealers").select("id, dealer_id, inventory_dealer_id, name").eq("id", co.dealer_id).single();
  const settings = await supplierSettings(admin, order.supplier_company_id);
  const { data: sup } = order.supplier_company_id ? await admin.from("crm_company_directory").select("name").eq("id", order.supplier_company_id).maybeSingle() : { data: null };

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
    fireWrite(admin.from("admin_audit").insert({ admin_user_id: staffId, action: "inventory_provider_changed", target_dealer_id: dealer.dealer_id, metadata: { via: "crm_feed_order", order_id: order.id, provider, is_dms: !!settings?.is_dms } }), "admin_audit");
  }
  let updated = await applyOrderEvent(admin, orderId, { type: "feed_id_confirmed", feedId: id, staffId }, staffId, { feed_id: id, provider });

  // Tell the dealer (new email from feeds@ to the approver).
  if (updated.approver_email) {
    try {
      const mb = await feedsMailbox(admin);
      const tpl = await resolveFeedTemplate(admin, "feed_assigned", updated.supplier_company_id);
      await sendInboxEmail({ staffId, mode: "new", mailboxId: mb.id, companyId: updated.dealer_company_id, to: [{ email: updated.approver_email, name: updated.approver_name }], subject: tpl.subject, bodyHtml: tpl.body_html, templateContext: await orderTemplateContext(admin, updated) }, admin);
    } catch (e) {
      await createOrderTask(admin, updated, { kind: "feed_notify_dealer", title: "Tell the dealer their feed is set up (the email didn't send)", description: e instanceof Error ? e.message : String(e) }, SYSTEM);
    }
  }
  updated = (await checkImport(admin, updated)) ?? updated;
  return updated;
}

/** assigned → done once the dealer has feed-owned vehicles (the platform's feed status). */
export async function checkImport(admin: Admin, order: any): Promise<any | null> {
  if (order.status !== "assigned") return null;
  const { data: co } = await admin.from("crm_companies").select("dealer_id").eq("id", order.dealer_company_id).single();
  const { data: dealer } = await admin.from("dealers").select("dealer_id, inventory_dealer_id").eq("id", co.dealer_id).single();
  const st = await getDealerFeedStatus(admin, dealer.dealer_id, dealer.inventory_dealer_id);
  if (st.signals.feedOwnedVehicles > 0) return applyOrderEvent(admin, order.id, { type: "import_succeeded", via: "feed_status" }, SYSTEM, { note: `${st.signals.feedOwnedVehicles} feed vehicles imported` });
  return null;
}

// ── Simple actions ───────────────────────────────────────────────────────────

export const markDealerApproved = (admin: Admin, id: string, staffId: string, note?: string) =>
  applyOrderEvent(admin, id, { type: "dealer_approved", via: "phone" }, staffId, { via: "phone", note: note ?? "Approved by phone" });

export const cancelOrder = (admin: Admin, id: string, reason: string, staffId: string) =>
  applyOrderEvent(admin, id, { type: "cancelled", reason }, staffId, { reason });

export async function reassignOwner(admin: Admin, id: string, ownerId: string | null, staffId: string): Promise<any> {
  const o = await applyOrderEvent(admin, id, { type: "owner_changed", ownerId }, staffId);
  if (ownerId) await admin.from("crm_tasks").update({ assigned_staff_id: ownerId }).eq("feed_order_id", id).eq("status", "open").is("assigned_capability", null);
  return o;
}

export { hasRequiredInfo, STATUS_LABEL, TransitionError, isOpen };

export function adminClient(): Admin { return createAdminSupabaseClient(); }
