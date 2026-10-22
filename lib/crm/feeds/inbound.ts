// feeds@ auto-detection — an onInboundEmail subscriber (feeds mailbox only).
// Which order (always the parent — one per request): a thread linked to an
// order (crm_email_threads.feed_order_id — ours, the supplier's own approval /
// case thread once matched, a fresh vAuto follow-up) → the order's own thread
// → a subject carrying the order's supplier case reference (vAuto's case #,
// Autosoft's Salesforce "[ ref:…:ref ]") → mail from the supplier's OR the
// dealer's domain naming one of the order's dealerships (subject without the
// suppliers' ticket tokens, or newest text); a match links the thread so the
// rest of that conversation follows. "From the supplier" = Graph's from OR
// sender (Autosoft writes through noreply@salesforce.com on its behalf).
//   • from the dealer's domain (anyone there, not only the approver we addressed):
//       – PDF supplier + a PDF attached → the signed authorization: stored on the
//         order, "Signed form received — forward to {supplier}" task, dealer approved
//       – an approval phrase in the newest text → dealer approved (ambiguous → "Review dealer reply")
//   • from the supplier: its case number → order metadata; a cancellation deadline
//     ("by end of day today", "within 3 Business days") while we wait on the dealer
//     → an immediate dealer follow-up on THAT message + owner task; then
//       – Feed IDs (supplier pattern — several per message, "SOUR17/SOUR75" — generic rules,
//         AI second opinion) → each offered to its dealership (Autosoft: by account; one
//         dealership: it; several: the one named beside it) → "Confirm Feed ID" per dealership
//         (never auto-confirmed); an ID no dealership matches → a review task
//       – its own approval request / a case notice → logged only
//       – a completion without a readable ID (or a manual-ID supplier) → "Enter Feed ID"
//       – anything else → "Review supplier reply"
//   • anything else on an order thread → "Review reply"; feeds@ mail no order matches → Unmatched
// Idempotent on email.id (an event carrying the email id means it was handled).
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createAdminSupabaseClient } from "@/lib/db";
import { registerInboundEmailHandler, type InboundEmailEvent } from "../email-hooks";
import { FREEMAIL_DOMAINS, emailDomain } from "../inbox-match";
import { DEFAULT_APPROVAL_PHRASES, detectOnOrder, domainMatches, isSupplierAddress, latestReplyText, mapFeedIds, mentionsDealer, subjectHasCaseRef, type SupplierSignals } from "./detect";
import { aiExtractFeedId } from "./ai-extract";
import { feedIdField } from "./extra-fields";
import { applyOrderEvent, attachSignedPdfFromEmail, createOrderTask, joinNames, linkThread, nudge, orderDealerships, recordEvent, supplierSettings, SYSTEM } from "./orders";
import { TransitionError } from "./state";

const OPEN = "(done,cancelled)";
const notFree = (d: string) => !!d && !FREEMAIL_DOMAINS.has(d);
const hostOf = (u: string | null) => (u ?? "").toLowerCase().replace(/^\s*[a-z]+:\/\//, "").replace(/^www\./, "").replace(/[/:?#].*$/, "");
/** Don't send a second automatic "the supplier will cancel" follow-up within this window. */
const DEADLINE_FOLLOWUP_GAP_MS = 12 * 3600_000;

/** The parent order's people and names: the dealer side covers the starting company and every dealership. */
export async function orderContext(admin: any, order: any) {
  const settings = await supplierSettings(admin, order.supplier_company_id);
  const supplierEmails = [settings?.request_email, ...(settings?.cc_emails ?? [])].filter((e): e is string => !!e).map((e) => e.toLowerCase());
  const dealerships = await orderDealerships(admin, order, { open: true });
  const companyIds = Array.from(new Set([order.dealer_company_id, ...dealerships.map((d) => d.companyId)]));
  const [{ data: contacts }, { data: cos }, { data: dir }, { data: sup }] = await Promise.all([
    admin.from("crm_contacts").select("email").in("company_id", companyIds).is("deleted_at", null).not("email", "is", null).limit(400),
    admin.from("crm_companies").select("website").in("id", companyIds),
    admin.from("crm_company_directory").select("name").eq("id", order.dealer_company_id).maybeSingle(),
    order.supplier_company_id ? admin.from("crm_company_directory").select("name").eq("id", order.supplier_company_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const dealerDomains = Array.from(new Set([
    order.approver_email ? emailDomain(order.approver_email) : "",
    ...(contacts ?? []).map((c: any) => emailDomain(String(c.email).toLowerCase())),
    ...(cos ?? []).map((c: any) => hostOf(c.website ?? null)),
  ].filter(notFree)));
  const supplierDomains = Array.from(new Set([...supplierEmails.map(emailDomain), ...(settings?.domains ?? [])].filter(notFree)));
  // Names the order can be recognised by: each dealership's, and the company it was started from (a group).
  const names = Array.from(new Set([...dealerships.map((d) => d.name), dir?.name ?? ""].filter(Boolean)));
  return { settings, supplierEmails, supplierDomains, dealerDomains, dealerName: joinNames(dealerships.map((d) => d.name)) || dir?.name || "", names, dealerships, supplierName: sup?.name ?? null };
}

async function alreadyHandled(admin: any, emailId: string): Promise<boolean> {
  const [{ data: ev }, { data: um }] = await Promise.all([
    admin.from("crm_feed_order_events").select("id").eq("detail->>email_id", emailId).limit(1),
    admin.from("crm_feed_unmatched").select("id").eq("email_id", emailId).limit(1),
  ]);
  return !!(ev?.length || um?.length);
}

/** Find the open (parent) order this message belongs to (see the header). */
async function findOrder(admin: any, e: InboundEmailEvent): Promise<any | null> {
  const parentOf = async (o: any | null) => (o?.parent_order_id ? (await admin.from("crm_feed_orders").select("*").eq("id", o.parent_order_id).not("status", "in", OPEN).maybeSingle()).data : o);
  const { data: th } = await admin.from("crm_email_threads").select("feed_order_id").eq("id", e.thread.id).maybeSingle();
  if (th?.feed_order_id) {
    const { data: linked } = await admin.from("crm_feed_orders").select("*").eq("id", th.feed_order_id).not("status", "in", OPEN).maybeSingle();
    const p = await parentOf(linked);
    if (p) return p;
  }
  const { data: byThread } = await admin.from("crm_feed_orders").select("*").eq("email_thread_id", e.thread.id).is("parent_order_id", null).not("status", "in", OPEN).maybeSingle();
  if (byThread) return byThread;
  const from = (e.email.from_email ?? "").toLowerCase();
  const sender = (e.email.sender_email ?? "").toLowerCase();
  if (!from && !sender) return null;
  const { data: open } = await admin.from("crm_feed_orders").select("*").is("parent_order_id", null).in("status", ["request_sent", "awaiting_dealer_approval", "awaiting_supplier", "feed_id_received"]).limit(500);
  // The supplier's case reference in the subject is the strongest signal (its new threads keep it).
  const byRef = (open ?? []).filter((o: any) => subjectHasCaseRef(e.email.subject, [o.metadata?.case_number, ...(o.metadata?.case_numbers ?? [])].filter(Boolean)));
  if (byRef.length === 1) return byRef[0];
  const latest = latestReplyText(e.email.body_text);
  const hits: any[] = [];
  for (const o of open ?? []) {
    const ctx = await orderContext(admin, o);
    const fromSupplier = isSupplierAddress(from, ctx) || isSupplierAddress(sender, ctx);
    const fromDealer = !!from && ((!!o.approver_email && o.approver_email === from) || domainMatches(emailDomain(from), ctx.dealerDomains));
    if ((fromSupplier || fromDealer) && ctx.names.some((n) => mentionsDealer(e.email.subject, latest, n))) hits.push(o);
  }
  // Two separate orders named in one message → a person decides (one order for both stores is one hit).
  return hits.length === 1 ? hits[0] : null;
}

/** `opts.orderId` = staff linked this message to an order (Feeds → Unmatched). */
export async function handleFeedsEmail(e: InboundEmailEvent, admin: any = createAdminSupabaseClient(), opts: { orderId?: string } = {}): Promise<string> {
  if (e.thread.internal && !opts.orderId) return "internal";
  if (await alreadyHandled(admin, e.email.id)) return "duplicate";
  let order = opts.orderId ? (await admin.from("crm_feed_orders").select("*").eq("id", opts.orderId).maybeSingle()).data : await findOrder(admin, e);
  if (order?.parent_order_id) order = (await admin.from("crm_feed_orders").select("*").eq("id", order.parent_order_id).maybeSingle()).data;
  if (!order) {
    await admin.from("crm_feed_unmatched").insert({ email_id: e.email.id, thread_id: e.thread.id, reason: "No open feed order matches this message" });
    return "unmatched";
  }
  if (!order.email_thread_id) await admin.from("crm_feed_orders").update({ email_thread_id: e.thread.id }).eq("id", order.id);
  await linkThread(admin, e.thread.id, order.id);

  const ctx = await orderContext(admin, order);
  const { data: s } = await admin.from("crm_settings").select("feed_approval_phrases").eq("id", true).maybeSingle();
  const phrases: string[] = [...(Array.isArray(s?.feed_approval_phrases) ? s.feed_approval_phrases : DEFAULT_APPROVAL_PHRASES), ...(ctx.settings?.approval_phrases ?? [])];
  const d = detectOnOrder({ from: e.email.from_email, sender: e.email.sender_email ?? null, text: e.email.body_text, subject: e.email.subject }, {
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
        await recordEvent(admin, order, "signed_pdf_received", { ...ref, note: pdf.placed.length ? `Signed PDFs received: ${pdf.placed.map((p) => `${p.dealership} — ${p.filename}`).join("; ")}` : `Signed PDF received: ${pdf.filename}` }, SYSTEM);
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
        // A completion: try for the IDs (unless this supplier's IDs are entered by hand).
        const manual = !!ctx.settings?.feed_id_manual;
        const regex = d.kind === "feed_id" ? d.candidates : [];
        const ai = manual || regex.length ? null : await aiExtractFeedId({ dealerName: ctx.dealerName, supplierName: ctx.supplierName, subject: e.email.subject, latestText: d.latest });
        const ids = regex.length ? regex : ai?.feed_id ? [ai.feed_id] : [];
        const idField = feedIdField(ctx.settings?.extra_fields ?? []);
        const kids = ctx.dealerships;
        const accountOf = (k: (typeof kids)[number]): string | null => (idField ? k.order.supplier_fields?.[idField.key] ?? null : null);
        if (!ids.length) {
          await applyOrderEvent(admin, order.id, { type: "supplier_replied" }, SYSTEM, ref).catch(() => undefined);
          const accounts = kids.filter(accountOf).map((k) => `${k.name}: ${accountOf(k)}`);
          await createOrderTask(admin, current, {
            kind: "feed_enter_feed_id",
            title: manual ? `${ctx.supplierName ?? "Supplier"} says it's set up — enter the Feed ID by hand` : "Supplier replied — no Feed ID found, enter it by hand",
            description: `"${d.latest.slice(0, 300)}"${accounts.length ? ` ${idField!.label} on the order — ${accounts.join(", ")}.` : ""}`,
          }, SYSTEM);
          return "supplier_no_id";
        }
        const map = mapFeedIds(ids, kids.map((k) => ({ id: k.order.id, name: k.name, account: accountOf(k) })), d.latest);
        const source = regex.length ? "regex" : "ai";
        let offered = 0;
        for (const m of map.mapped) {
          const k = kids.find((x) => x.order.id === m.dealershipId)!;
          if (!["pending", "feed_id_received"].includes(k.order.status)) {
            if (k.order.feed_id_confirmed !== m.feedId) await review("feed_review_supplier_reply", `${ctx.supplierName ?? "Supplier"} sent Feed ID ${m.feedId} for ${k.name}, which already has ${k.order.feed_id_confirmed ?? "a confirmed ID"}`);
            continue;
          }
          const o = await applyOrderEvent(admin, k.order.id, { type: "feed_id_detected", candidate: m.feedId, source }, SYSTEM, {
            ...ref, candidate: m.feedId, regex_candidates: regex, ai_feed_id: ai?.feed_id ?? null, ai_confidence: ai?.confidence ?? null, ai_quote: ai?.quote ?? null,
          });
          offered++;
          const notes = [
            map.others.length ? `Other matches: ${map.others.join(", ")}.` : "",
            accountOf(k) ? `Matches the ${idField!.label.toLowerCase()} on the order.` : "",
            kids.length > 1 && !accountOf(k) ? `Matched to ${k.name} by the name beside it — check it's this store's.` : "",
            ai?.feed_id ? `Read by AI (${ai.confidence}) — check before confirming.` : "",
          ].filter(Boolean).join(" ");
          await createOrderTask(admin, o, { kind: "feed_confirm_id", title: `Confirm Feed ID ${m.feedId}${kids.length > 1 ? ` for ${k.name}` : ""}`, description: notes || null }, SYSTEM);
        }
        if (map.unmatched.length) {
          const fresh = (await admin.from("crm_feed_orders").select("*").eq("id", order.id).maybeSingle()).data ?? order;
          // With accounts on the order (Autosoft) an unknown code is a mistake to check; without them a person maps it.
          const flagged = !!idField && kids.some((k) => accountOf(k));
          const meta = { ...(fresh.metadata ?? {}), unmatched_feed_ids: Array.from(new Set([...(fresh.metadata?.unmatched_feed_ids ?? []), ...map.unmatched])) };
          await admin.from("crm_feed_orders").update({ metadata: meta }).eq("id", order.id);
          await recordEvent(admin, fresh, "feed_id_unmatched", { ...ref, note: `${map.unmatched.join(", ")} — ${flagged ? `no dealership on the order has that ${idField!.label.toLowerCase()}` : "couldn't tell which dealership"}` }, SYSTEM);
          await createOrderTask(admin, fresh, flagged
            ? { kind: "feed_review_supplier_reply", title: `${ctx.supplierName ?? "Supplier"} activated ${map.unmatched.join(", ")} — no dealership on this order has that ${idField!.label.toLowerCase()}`, description: `On the order: ${kids.map((k) => `${k.name} ${accountOf(k) ?? "(none)"}`).join(", ")}. "${d.latest.slice(0, 300)}"` }
            : { kind: "feed_map_ids", title: `Feed IDs ${map.unmatched.join(", ")} — pick which dealership each is for`, description: `"${d.latest.slice(0, 300)}"` }, SYSTEM);
        }
        if (!offered && !map.unmatched.length) return "review_supplier_reply";
        return offered ? "feed_id" : "feed_id_unmatched";
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
