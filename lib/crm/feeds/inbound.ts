// feeds@ auto-detection — an onInboundEmail subscriber (feeds mailbox only).
// Which order: a thread linked to an order (crm_email_threads.feed_order_id —
// ours, the supplier's own approval / case thread once matched, a fresh vAuto
// follow-up) → the order's own thread → mail from the supplier's OR the
// dealer's domain naming the dealer (subject or newest text); a match links
// the thread so the rest of that conversation follows.
//   • from the dealer's domain (anyone there, not only the approver we addressed):
//       – PDF supplier + a PDF attached → the signed authorization: stored on the
//         order, "Signed form received — forward to {supplier}" task, dealer approved
//       – an approval phrase in the newest text → dealer approved (ambiguous → "Review dealer reply")
//   • from the supplier: its case number → order metadata; a cancellation deadline
//     ("by end of day today", "within 3 Business days") while we wait on the dealer
//     → an immediate dealer follow-up on THAT message + owner task; then
//       – a Feed ID (supplier pattern, generic rules, AI second opinion) → "Confirm Feed ID"
//         (never auto-confirmed)
//       – its own approval request / a case notice → logged only
//       – a completion without a readable ID (or a manual-ID supplier) → "Enter Feed ID"
//       – anything else → "Review supplier reply"
//   • anything else on an order thread → "Review reply"; feeds@ mail no order matches → Unmatched
// Idempotent on email.id (an event carrying the email id means it was handled).
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createAdminSupabaseClient } from "@/lib/db";
import { registerInboundEmailHandler, type InboundEmailEvent } from "../email-hooks";
import { FREEMAIL_DOMAINS, emailDomain } from "../inbox-match";
import { DEFAULT_APPROVAL_PHRASES, detectOnOrder, domainMatches, latestReplyText, mentionsDealer, type SupplierSignals } from "./detect";
import { aiExtractFeedId } from "./ai-extract";
import { applyOrderEvent, attachSignedPdfFromEmail, createOrderTask, linkThread, nudge, recordEvent, supplierSettings, SYSTEM } from "./orders";
import { TransitionError } from "./state";

const OPEN = "(done,cancelled)";
const notFree = (d: string) => !!d && !FREEMAIL_DOMAINS.has(d);
const hostOf = (u: string | null) => (u ?? "").toLowerCase().replace(/^\s*[a-z]+:\/\//, "").replace(/^www\./, "").replace(/[/:?#].*$/, "");
/** Don't send a second automatic "the supplier will cancel" follow-up within this window. */
const DEADLINE_FOLLOWUP_GAP_MS = 12 * 3600_000;

export async function orderContext(admin: any, order: any) {
  const settings = await supplierSettings(admin, order.supplier_company_id);
  const supplierEmails = [settings?.request_email, ...(settings?.cc_emails ?? [])].filter((e): e is string => !!e).map((e) => e.toLowerCase());
  const [{ data: contacts }, { data: co }, { data: dir }, { data: sup }] = await Promise.all([
    admin.from("crm_contacts").select("email").eq("company_id", order.dealer_company_id).is("deleted_at", null).not("email", "is", null).limit(200),
    admin.from("crm_companies").select("website").eq("id", order.dealer_company_id).maybeSingle(),
    admin.from("crm_company_directory").select("name").eq("id", order.dealer_company_id).maybeSingle(),
    order.supplier_company_id ? admin.from("crm_company_directory").select("name").eq("id", order.supplier_company_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const dealerDomains = Array.from(new Set([
    order.approver_email ? emailDomain(order.approver_email) : "",
    ...(contacts ?? []).map((c: any) => emailDomain(String(c.email).toLowerCase())),
    hostOf(co?.website ?? null),
  ].filter(notFree)));
  const supplierDomains = Array.from(new Set([...supplierEmails.map(emailDomain), ...(settings?.domains ?? [])].filter(notFree)));
  return { settings, supplierEmails, supplierDomains, dealerDomains, dealerName: dir?.name ?? "", supplierName: sup?.name ?? null };
}

async function alreadyHandled(admin: any, emailId: string): Promise<boolean> {
  const [{ data: ev }, { data: um }] = await Promise.all([
    admin.from("crm_feed_order_events").select("id").eq("detail->>email_id", emailId).limit(1),
    admin.from("crm_feed_unmatched").select("id").eq("email_id", emailId).limit(1),
  ]);
  return !!(ev?.length || um?.length);
}

/** Find the open order this message belongs to (see the header). */
async function findOrder(admin: any, e: InboundEmailEvent): Promise<any | null> {
  const { data: th } = await admin.from("crm_email_threads").select("feed_order_id").eq("id", e.thread.id).maybeSingle();
  if (th?.feed_order_id) {
    const { data: linked } = await admin.from("crm_feed_orders").select("*").eq("id", th.feed_order_id).not("status", "in", OPEN).maybeSingle();
    if (linked) return linked;
  }
  const { data: byThread } = await admin.from("crm_feed_orders").select("*").eq("email_thread_id", e.thread.id).not("status", "in", OPEN).maybeSingle();
  if (byThread) return byThread;
  const from = (e.email.from_email ?? "").toLowerCase();
  if (!from) return null;
  const { data: open } = await admin.from("crm_feed_orders").select("*").in("status", ["request_sent", "awaiting_dealer_approval", "awaiting_supplier", "feed_id_received"]).limit(500);
  const latest = latestReplyText(e.email.body_text);
  const d = emailDomain(from);
  const hits: any[] = [];
  for (const o of open ?? []) {
    const ctx = await orderContext(admin, o);
    const fromSupplier = ctx.supplierEmails.includes(from) || domainMatches(d, ctx.supplierDomains);
    const fromDealer = (!!o.approver_email && o.approver_email === from) || domainMatches(d, ctx.dealerDomains);
    if ((fromSupplier || fromDealer) && ctx.dealerName && mentionsDealer(e.email.subject, latest, ctx.dealerName)) hits.push(o);
  }
  // Two orders named in one message ("… for: Store A and Store B") → a person decides.
  return hits.length === 1 ? hits[0] : null;
}

/** `opts.orderId` = staff linked this message to an order (Feeds → Unmatched). */
export async function handleFeedsEmail(e: InboundEmailEvent, admin: any = createAdminSupabaseClient(), opts: { orderId?: string } = {}): Promise<string> {
  if (e.thread.internal && !opts.orderId) return "internal";
  if (await alreadyHandled(admin, e.email.id)) return "duplicate";
  const order = opts.orderId ? (await admin.from("crm_feed_orders").select("*").eq("id", opts.orderId).maybeSingle()).data : await findOrder(admin, e);
  if (!order) {
    await admin.from("crm_feed_unmatched").insert({ email_id: e.email.id, thread_id: e.thread.id, reason: "No open feed order matches this message" });
    return "unmatched";
  }
  if (!order.email_thread_id) await admin.from("crm_feed_orders").update({ email_thread_id: e.thread.id }).eq("id", order.id);
  await linkThread(admin, e.thread.id, order.id);

  const ctx = await orderContext(admin, order);
  const { data: s } = await admin.from("crm_settings").select("feed_approval_phrases").eq("id", true).maybeSingle();
  const phrases: string[] = [...(Array.isArray(s?.feed_approval_phrases) ? s.feed_approval_phrases : DEFAULT_APPROVAL_PHRASES), ...(ctx.settings?.approval_phrases ?? [])];
  const d = detectOnOrder({ from: e.email.from_email, text: e.email.body_text, subject: e.email.subject }, {
    status: order.status, approverEmail: order.approver_email, dealerDomains: ctx.dealerDomains,
    supplierEmails: ctx.supplierEmails, supplierDomains: ctx.supplierDomains, feedIdPattern: ctx.settings?.feed_id_pattern ?? null,
    feedIdManual: !!ctx.settings?.feed_id_manual, casePattern: ctx.settings?.case_number_pattern ?? null, cancellationPatterns: ctx.settings?.cancellation_patterns ?? [],
  }, phrases);
  const ref = { email_id: e.email.id, thread_id: e.thread.id, from: e.email.from_email, excerpt: d.latest.slice(0, 600) };
  const review = async (kind: string, title: string) => {
    await recordEvent(admin, order, "review", { ...ref, note: title }, SYSTEM);
    await createOrderTask(admin, order, { kind, title, description: `From ${e.email.from_email}: "${d.latest.slice(0, 300)}"` }, SYSTEM);
  };

  try {
    // The dealer returning the signed authorization (PDF suppliers) — approval by signature.
    if (ctx.settings?.request_method === "pdf" && e.email.has_attachments && (d.kind === "dealer_approved" || d.kind === "review_dealer_reply" || d.kind === "review_reply") && isDealer(e.email.from_email, order, ctx)) {
      const pdf = await attachSignedPdfFromEmail(admin, order, e.email.id, ctx.supplierName);
      if (pdf) {
        await recordEvent(admin, order, "signed_pdf_received", { ...ref, note: `Signed PDF received: ${pdf.filename}` }, SYSTEM);
        if (["request_sent", "awaiting_dealer_approval", "awaiting_supplier"].includes(order.status)) {
          await applyOrderEvent(admin, order.id, { type: "dealer_approved", via: "signed_pdf" }, SYSTEM, { ...ref, via: "signed_pdf" });
        }
        return "signed_pdf";
      }
    }

    switch (d.kind) {
      case "dealer_approved":
        await applyOrderEvent(admin, order.id, { type: "dealer_approved", via: "email" }, SYSTEM, { ...ref, via: "email" });
        return "dealer_approved";
      case "review_dealer_reply":
        await review("feed_review_dealer_reply", "Review dealer reply");
        return "review_dealer_reply";
      case "feed_id":
      case "supplier_no_id": {
        const current = await supplierBookkeeping(admin, order, d.supplier, e, ref, ctx.supplierName);
        if (d.kind === "supplier_no_id" && d.supplier.kind !== "completion") {
          if (d.supplier.kind === "approval_request" || d.supplier.kind === "acknowledgement") {
            await recordEvent(admin, current, "supplier_message", { ...ref, note: d.supplier.kind === "approval_request" ? "Supplier asked the dealer for approval" : "Supplier case notice" }, SYSTEM);
            return d.supplier.kind;
          }
          await applyOrderEvent(admin, order.id, { type: "supplier_replied" }, SYSTEM, ref).catch(() => undefined);
          await review("feed_review_supplier_reply", "Review supplier reply");
          return "review_supplier_reply";
        }
        // A completion: try for the ID (unless this supplier's IDs are entered by hand).
        const manual = !!ctx.settings?.feed_id_manual;
        const ai = manual ? null : await aiExtractFeedId({ dealerName: ctx.dealerName, supplierName: ctx.supplierName, subject: e.email.subject, latestText: d.latest });
        const regex = d.kind === "feed_id" ? d.candidates : [];
        const candidate = regex[0] ?? ai?.feed_id ?? null;
        if (!candidate) {
          await applyOrderEvent(admin, order.id, { type: "supplier_replied" }, SYSTEM, ref).catch(() => undefined);
          const hint = order.supplier_fields?.autosoft_account ? ` The order's Autosoft account is ${order.supplier_fields.autosoft_account}.` : "";
          await createOrderTask(admin, current, {
            kind: "feed_enter_feed_id",
            title: manual ? `${ctx.supplierName ?? "Supplier"} says it's set up — enter the Feed ID by hand` : "Supplier replied — no Feed ID found, enter it by hand",
            description: `"${d.latest.slice(0, 300)}"${hint}`,
          }, SYSTEM);
          return "supplier_no_id";
        }
        const o = await applyOrderEvent(admin, order.id, { type: "feed_id_detected", candidate, source: regex.length ? "regex" : "ai" }, SYSTEM, {
          ...ref, candidate, regex_candidates: regex, ai_feed_id: ai?.feed_id ?? null, ai_confidence: ai?.confidence ?? null, ai_quote: ai?.quote ?? null,
        });
        const notes = [
          regex.length > 1 ? `Other matches: ${regex.slice(1).join(", ")}.` : "",
          ai?.feed_id && ai.feed_id !== candidate ? `AI read it as ${ai.feed_id} (${ai.confidence}) — check before confirming.` : ai?.feed_id ? `AI agrees (${ai.confidence}).` : "",
        ].filter(Boolean).join(" ");
        await createOrderTask(admin, o, { kind: "feed_confirm_id", title: `Confirm Feed ID ${candidate}`, description: notes || null }, SYSTEM);
        return "feed_id";
      }
      default:
        await review("feed_review_reply", "Review reply");
        return "review_reply";
    }
  } catch (err) {
    if (err instanceof TransitionError) { await review("feed_review_reply", "Review reply"); return "review_reply"; }
    throw err;
  }
}

function isDealer(from: string | null, order: any, ctx: { dealerDomains: string[] }): boolean {
  const f = (from ?? "").toLowerCase();
  return !!f && ((!!order.approver_email && f === order.approver_email) || domainMatches(emailDomain(f), ctx.dealerDomains));
}

/**
 * Case number → order metadata. A cancellation deadline while we still wait on the dealer →
 * immediate dealer follow-up (reply all on the supplier's message, so the approval lands in the
 * supplier's own loop) + a task for the owner — the day-2 stall timer doesn't wait. Returns the
 * freshest order row.
 */
async function supplierBookkeeping(admin: any, order: any, sig: SupplierSignals, e: InboundEmailEvent, ref: Record<string, unknown>, supplierName: string | null): Promise<any> {
  const meta = { ...(order.metadata ?? {}) };
  let changed = false;
  if (sig.caseNumber && meta.case_number !== sig.caseNumber) {
    meta.case_numbers = Array.from(new Set([...(meta.case_numbers ?? []), sig.caseNumber]));
    meta.case_number = sig.caseNumber;
    changed = true;
    await recordEvent(admin, order, "case_number", { ...ref, note: `${supplierName ?? "Supplier"} case ${sig.caseNumber}` }, SYSTEM);
  }
  const waitingOnDealer = ["request_sent", "awaiting_dealer_approval"].includes(order.status);
  if (sig.cancellation && waitingOnDealer) {
    const last = meta.cancellation_deadline?.followed_up_at ? Date.parse(meta.cancellation_deadline.followed_up_at) : 0;
    meta.cancellation_deadline = { text: sig.cancellation, at: e.email.received_at, followed_up_at: meta.cancellation_deadline?.followed_up_at ?? null };
    changed = true;
    await recordEvent(admin, order, "cancellation_deadline", { ...ref, note: sig.cancellation }, SYSTEM);
    await createOrderTask(admin, order, {
      kind: "feed_supplier_deadline",
      title: `${supplierName ?? "The supplier"} will cancel without approval — get ${order.approver_name ?? "the approver"} to reply today`,
      description: `"${sig.cancellation}"${order.approver_phone ? ` Approver: ${order.approver_phone}.` : ""}`,
      due: new Date().toISOString(),
    }, SYSTEM);
    if (Date.now() - last > DEADLINE_FOLLOWUP_GAP_MS) {
      try {
        await nudge(admin, order.id, "dealer", SYSTEM, false, { replyToEmailId: e.email.id });
        meta.cancellation_deadline.followed_up_at = new Date().toISOString();
      } catch (err) {
        await createOrderTask(admin, order, { kind: "feed_call_approver", title: "Deadline follow-up couldn't send — call the approver", description: err instanceof Error ? err.message : String(err) }, SYSTEM);
      }
    }
  }
  if (!changed) return order;
  const { data } = await admin.from("crm_feed_orders").update({ metadata: meta }).eq("id", order.id).select("*").maybeSingle();
  return data ?? { ...order, metadata: meta };
}

registerInboundEmailHandler("feeds", (e) => handleFeedsEmail(e).then(() => undefined), { purpose: "feeds" });
