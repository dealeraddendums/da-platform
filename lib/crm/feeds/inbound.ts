// feeds@ auto-detection — an onInboundEmail subscriber (feeds mailbox only).
//   • on an order's thread, from the approver / dealer domain, with an approval
//     phrase in the newest text → dealer approved (ambiguous → "Review dealer reply")
//   • from the supplier (on the thread, or any feeds@ mail from the supplier's
//     domain naming the dealer) → Feed ID candidate(s) by the supplier's pattern
//     + the generic rules, with the AI extractor as a second opinion → "Confirm
//     Feed ID" (never auto-confirmed); nothing found → "Enter Feed ID" task
//   • anything else on an order thread → "Review reply"
//   • feeds@ mail no order matches → Feeds queue → Unmatched
// Idempotent on email.id (an event carrying the email id means it was handled).
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createAdminSupabaseClient } from "@/lib/db";
import { registerInboundEmailHandler, type InboundEmailEvent } from "../email-hooks";
import { FREEMAIL_DOMAINS, emailDomain } from "../inbox-match";
import { DEFAULT_APPROVAL_PHRASES, detectOnOrder, latestReplyText, mentionsDealer } from "./detect";
import { aiExtractFeedId } from "./ai-extract";
import { applyOrderEvent, createOrderTask, recordEvent, supplierSettings, SYSTEM } from "./orders";
import { TransitionError } from "./state";

const OPEN = "(done,cancelled)";
const notFree = (d: string) => !!d && !FREEMAIL_DOMAINS.has(d);
const hostOf = (u: string | null) => (u ?? "").toLowerCase().replace(/^\s*[a-z]+:\/\//, "").replace(/^www\./, "").replace(/[/:?#].*$/, "");

export async function orderContext(admin: any, order: any) {
  const settings = await supplierSettings(admin, order.supplier_company_id);
  const supplierEmails = [settings?.request_email, ...(settings?.cc_emails ?? [])].filter((e): e is string => !!e).map((e) => e.toLowerCase());
  const [{ data: contacts }, { data: co }, { data: dir }] = await Promise.all([
    admin.from("crm_contacts").select("email").eq("company_id", order.dealer_company_id).is("deleted_at", null).not("email", "is", null).limit(200),
    admin.from("crm_companies").select("website").eq("id", order.dealer_company_id).maybeSingle(),
    admin.from("crm_company_directory").select("name").eq("id", order.dealer_company_id).maybeSingle(),
  ]);
  const dealerDomains = Array.from(new Set([
    order.approver_email ? emailDomain(order.approver_email) : "",
    ...(contacts ?? []).map((c: any) => emailDomain(String(c.email).toLowerCase())),
    hostOf(co?.website ?? null),
  ].filter(notFree)));
  const supplierDomains = Array.from(new Set(supplierEmails.map(emailDomain).filter(notFree)));
  return { settings, supplierEmails, supplierDomains, dealerDomains, dealerName: dir?.name ?? "" };
}

async function alreadyHandled(admin: any, emailId: string): Promise<boolean> {
  const [{ data: ev }, { data: um }] = await Promise.all([
    admin.from("crm_feed_order_events").select("id").eq("detail->>email_id", emailId).limit(1),
    admin.from("crm_feed_unmatched").select("id").eq("email_id", emailId).limit(1),
  ]);
  return !!(ev?.length || um?.length);
}

/** Find the open order this message belongs to: the thread, else supplier mail naming the dealer. */
async function findOrder(admin: any, e: InboundEmailEvent): Promise<any | null> {
  const { data: byThread } = await admin.from("crm_feed_orders").select("*").eq("email_thread_id", e.thread.id).not("status", "in", OPEN).maybeSingle();
  if (byThread) return byThread;
  const from = (e.email.from_email ?? "").toLowerCase();
  if (!from) return null;
  const { data: open } = await admin.from("crm_feed_orders").select("*").in("status", ["request_sent", "awaiting_dealer_approval", "awaiting_supplier", "feed_id_received"]).limit(500);
  const latest = latestReplyText(e.email.body_text);
  const hits: any[] = [];
  for (const o of open ?? []) {
    const ctx = await orderContext(admin, o);
    const fromSupplier = ctx.supplierEmails.includes(from) || ctx.supplierDomains.includes(emailDomain(from));
    if (fromSupplier && ctx.dealerName && mentionsDealer(e.email.subject, latest, ctx.dealerName)) hits.push(o);
  }
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

  const ctx = await orderContext(admin, order);
  const { data: s } = await admin.from("crm_settings").select("feed_approval_phrases").eq("id", true).maybeSingle();
  const phrases: string[] = Array.isArray(s?.feed_approval_phrases) ? s.feed_approval_phrases : DEFAULT_APPROVAL_PHRASES;
  const d = detectOnOrder({ from: e.email.from_email, text: e.email.body_text }, {
    status: order.status, approverEmail: order.approver_email, dealerDomains: ctx.dealerDomains,
    supplierEmails: ctx.supplierEmails, supplierDomains: ctx.supplierDomains, feedIdPattern: ctx.settings?.feed_id_pattern ?? null,
  }, phrases);
  const ref = { email_id: e.email.id, thread_id: e.thread.id, from: e.email.from_email, excerpt: d.latest.slice(0, 600) };
  const review = async (kind: string, title: string) => {
    await recordEvent(admin, order, "review", { ...ref, note: title }, SYSTEM);
    await createOrderTask(admin, order, { kind, title, description: `From ${e.email.from_email}: "${d.latest.slice(0, 300)}"` }, SYSTEM);
  };

  try {
    switch (d.kind) {
      case "dealer_approved":
        await applyOrderEvent(admin, order.id, { type: "dealer_approved", via: "email" }, SYSTEM, { ...ref, via: "email" });
        return "dealer_approved";
      case "review_dealer_reply":
        await review("feed_review_dealer_reply", "Review dealer reply");
        return "review_dealer_reply";
      case "feed_id":
      case "supplier_no_id": {
        const ai = await aiExtractFeedId({ dealerName: ctx.dealerName, supplierName: null, subject: e.email.subject, latestText: d.latest });
        const regex = d.kind === "feed_id" ? d.candidates : [];
        const candidate = regex[0] ?? ai?.feed_id ?? null;
        if (!candidate) {
          await applyOrderEvent(admin, order.id, { type: "supplier_replied" }, SYSTEM, ref).catch(() => undefined);
          await createOrderTask(admin, order, { kind: "feed_enter_feed_id", title: "Supplier replied — no Feed ID found, enter it by hand", description: `"${d.latest.slice(0, 300)}"` }, SYSTEM);
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

registerInboundEmailHandler("feeds", (e) => handleFeedsEmail(e).then(() => undefined), { purpose: "feeds" });
