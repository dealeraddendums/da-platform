/* npm run test:crm-feeds — DA-CRM Phase 2b feed orders, no database or network:
   every advanceOrder() transition (and the refusals), the stall rules,
   business days, approval / Feed ID detection against sample emails (real
   supplier phrasing from support@, 2026), sender classification, PDF fill
   with the sample template, template resolution, and the feeds@ inbound
   handler end-to-end against the in-memory Supabase fake. */
/* eslint-disable @typescript-eslint/no-explicit-any */
delete process.env.ANTHROPIC_API_KEY;   // AI second opinion off: deterministic

import { advanceOrder, stallActions, hasRequiredInfo, TransitionError, ageColor, type OrderState, type OrderEvent, type OrderStatus } from "../lib/crm/feeds/state";
import { latestReplyText, classifyApproval, extractFeedIds, classifySender, detectOnOrder, mentionsDealer, compilePattern } from "../lib/crm/feeds/detect";
import { businessDaysBetween, isBusinessDay, usHolidays, nextBusinessDayDue } from "../lib/crm/business-days";
import { fillRequestPdf, samplePdfTemplate, SAMPLE_PDF_FIELD_MAP, pdfFieldNames } from "../lib/crm/feeds/pdf";
import { resolveFeedTemplate, DEFAULT_FEED_TEMPLATES, APPROVAL_INSTRUCTION, orderNumber } from "../lib/crm/feeds/templates";
import { handleFeedsEmail } from "../lib/crm/feeds/inbound";
import { unregisterInboundEmailHandler, type InboundEmailEvent } from "../lib/crm/email-hooks";
import { renderTemplate } from "../lib/crm/template-vars";
import { PDFDocument } from "pdf-lib";
import { fakeDb } from "./crm-fake-supabase";

let fail = 0, pass = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`}`);
}
const throws = (fn: () => unknown) => { try { fn(); return false; } catch (e) { return e instanceof TransitionError; } };

const NOW = new Date("2026-10-21T18:00:00Z");
const full: OrderState = { status: "needs_info", supplier_company_id: "sup", approver_name: "Bill Meier", approver_email: "bill@herzogmeier.com", stalled_nudges: 0 };
const st = (status: OrderStatus, over: Partial<OrderState> = {}): OrderState => ({ ...full, status, ...over });
const email = { method: "email" as const, now: NOW };

async function main() {
  // ── State machine: every transition ─────────────────────────────────────
  eq("created with everything → ready", advanceOrder({ ...full }, { type: "created" }, email).status, "ready");
  eq("created missing approver → needs_info", advanceOrder({ ...full, approver_email: null }, { type: "created" }, email).status, "needs_info");
  eq("created missing supplier → needs_info", advanceOrder({ ...full, supplier_company_id: null }, { type: "created" }, email).status, "needs_info");
  eq("created, portal supplier, no approver → ready", advanceOrder({ ...full, approver_email: null, approver_name: null }, { type: "created" }, { method: "api" }).status, "ready");
  eq("hasRequiredInfo needs an approver name too", hasRequiredInfo({ supplier_company_id: "s", approver_email: "a@b.com", approver_name: " " }, "email"), false);

  const fill = advanceOrder(st("needs_info", { approver_email: null }), { type: "info_updated", fields: { approver_email: "gm@d.com" } }, email);
  eq("info_updated fills the gap → ready (+ patch)", [fill.status, fill.patch.approver_email, fill.changed], ["ready", "gm@d.com", true]);
  eq("info_updated removes the supplier → back to needs_info", advanceOrder(st("ready"), { type: "info_updated", fields: { supplier_company_id: null } }, email).status, "needs_info");
  eq("info_updated (change approver) while awaiting approval keeps the status, restarts the timer",
    (() => { const a = advanceOrder(st("awaiting_dealer_approval", { stalled_nudges: 1 }), { type: "info_updated", fields: { approver_email: "new@d.com" } }, email); return [a.status, a.patch.stalled_nudges, a.patch.stall_timer_started_at]; })(),
    ["awaiting_dealer_approval", 0, NOW.toISOString()]);
  eq("info_updated refused once assigned", throws(() => advanceOrder(st("assigned"), { type: "info_updated", fields: {} }, email)), true);

  const sent = advanceOrder(st("ready"), { type: "request_sent", threadId: "t1" }, email);
  eq("request_sent → awaiting_dealer_approval, records thread + sent_at", [sent.status, sent.patch.email_thread_id, sent.patch.sent_at], ["awaiting_dealer_approval", "t1", NOW.toISOString()]);
  eq("request_sent, portal supplier → awaiting_supplier", advanceOrder(st("ready"), { type: "request_sent", threadId: null }, { method: "api" }).status, "awaiting_supplier");
  eq("request_sent refused from needs_info", throws(() => advanceOrder(st("needs_info"), { type: "request_sent", threadId: null }, email)), true);
  eq("request_sent refused twice", throws(() => advanceOrder(st("awaiting_dealer_approval"), { type: "request_sent", threadId: null }, email)), true);

  eq("resent keeps awaiting_dealer_approval, new thread", (() => { const a = advanceOrder(st("awaiting_dealer_approval"), { type: "resent", threadId: "t2" }, email); return [a.status, a.patch.email_thread_id]; })(), ["awaiting_dealer_approval", "t2"]);
  eq("resent refused before the first send", throws(() => advanceOrder(st("ready"), { type: "resent", threadId: null }, email)), true);

  const appr = advanceOrder(st("awaiting_dealer_approval", { stalled_nudges: 2 }), { type: "dealer_approved", via: "email" }, email);
  eq("dealer_approved → awaiting_supplier, stamps + restarts the timer", [appr.status, appr.patch.dealer_approved_at, appr.patch.stalled_nudges], ["awaiting_supplier", NOW.toISOString(), 0]);
  eq("dealer_approved also from request_sent", advanceOrder(st("request_sent"), { type: "dealer_approved", via: "phone" }, email).status, "awaiting_supplier");
  eq("dealer_approved refused when already approved", throws(() => advanceOrder(st("awaiting_supplier"), { type: "dealer_approved", via: "email" }, email)), true);

  eq("supplier_replied stamps, status unchanged", (() => { const a = advanceOrder(st("awaiting_supplier"), { type: "supplier_replied" }, email); return [a.status, a.changed, !!a.patch.supplier_replied_at]; })(), ["awaiting_supplier", false, true]);
  eq("supplier_replied refused in needs_info", throws(() => advanceOrder(st("needs_info"), { type: "supplier_replied" }, email)), true);

  // A dealership's child order carries the Feed ID part.
  const kid = (status: OrderStatus, over: Partial<OrderState> = {}): OrderState => ({ ...full, status, parent_order_id: "parent", ...over });
  eq("child created → pending", advanceOrder(kid("needs_info"), { type: "created" }, email).status, "pending");
  for (const from of ["pending", "feed_id_received"] as OrderStatus[]) {
    eq(`child feed_id_detected from ${from} → feed_id_received`, (() => { const a = advanceOrder(kid(from), { type: "feed_id_detected", candidate: " MP12601 ", source: "regex" }, email); return [a.status, a.patch.feed_id_candidate]; })(), ["feed_id_received", "MP12601"]);
  }
  eq("child feed_id_entered → feed_id_received", advanceOrder(kid("pending"), { type: "feed_id_entered", candidate: "X1" }, email).status, "feed_id_received");
  eq("feed_id refused when empty", throws(() => advanceOrder(kid("pending"), { type: "feed_id_entered", candidate: "  " }, email)), true);
  eq("feed_id refused once assigned", throws(() => advanceOrder(kid("assigned"), { type: "feed_id_entered", candidate: "X" }, email)), true);
  eq("Feed ID events refused on the parent (they belong to its dealerships)", ["feed_id_detected", "feed_id_entered", "feed_id_confirmed", "import_succeeded"].map((t) => throws(() => advanceOrder(st("awaiting_supplier"), { type: t, candidate: "X", feedId: "X", staffId: "s", source: "regex", via: "feed_status" } as unknown as OrderEvent, email))), [true, true, true, true]);
  eq("request events refused on a dealership", ["request_sent", "dealer_approved", "nudged", "owner_changed"].map((t) => throws(() => advanceOrder(kid("pending"), { type: t, threadId: null, via: "email", target: "dealer", manual: true, ownerId: null } as unknown as OrderEvent, email))), [true, true, true, true]);

  const conf = advanceOrder(kid("feed_id_received"), { type: "feed_id_confirmed", feedId: "MP12601", staffId: "s1" }, email);
  eq("feed_id_confirmed → assigned with who/when", [conf.status, conf.patch.feed_id_confirmed, conf.patch.confirmed_by_staff_id, conf.patch.assigned_at], ["assigned", "MP12601", "s1", NOW.toISOString()]);
  eq("feed_id_confirmed refused without a candidate step", throws(() => advanceOrder(kid("pending"), { type: "feed_id_confirmed", feedId: "X", staffId: "s" }, email)), true);
  eq("import_succeeded → done", advanceOrder(kid("assigned"), { type: "import_succeeded", via: "feed_status" }, email).status, "done");
  eq("import_succeeded refused before assignment", throws(() => advanceOrder(kid("feed_id_received"), { type: "import_succeeded", via: "no_status" }, email)), true);
  eq("child cancelled with a reason", advanceOrder(kid("pending"), { type: "cancelled", reason: "Sold the store" }, email).status, "cancelled");

  // The parent follows its dealerships.
  for (const from of ["awaiting_supplier", "awaiting_dealer_approval", "needs_info", "ready"] as OrderStatus[]) {
    eq(`parent dealership_feed_id from ${from} → feed_id_received`, advanceOrder(st(from), { type: "dealership_feed_id", fromSupplier: true }, email).status, "feed_id_received");
  }
  eq("parent dealerships_complete → done", advanceOrder(st("feed_id_received"), { type: "dealerships_complete" }, email).status, "done");
  eq("parent dealerships_complete refused when cancelled", throws(() => advanceOrder(st("cancelled"), { type: "dealerships_complete" }, email)), true);
  eq("nudge supplier still allowed while some dealerships wait (feed_id_received)", advanceOrder(st("feed_id_received"), { type: "nudged", target: "supplier", manual: true }, email).status, "feed_id_received");
  eq("required per-dealership answers: each rooftop needs its own",
    [hasRequiredInfo({ ...full, dealerships: [{ name: "A", fields: { acct: "AAAA11" } }, { name: "B", fields: {} }] }, "email", [{ key: "acct", label: "Acct", type: "text", required: true, per_dealership: true }]),
     hasRequiredInfo({ ...full, dealerships: [{ name: "A", fields: { acct: "AAAA11" } }, { name: "B", fields: { acct: "BBBB22" } }] }, "email", [{ key: "acct", label: "Acct", type: "text", required: true, per_dealership: true }])],
    [false, true]);

  const autoNudge = advanceOrder(st("awaiting_dealer_approval", { stalled_nudges: 0 }), { type: "nudged", target: "dealer", manual: false }, email);
  eq("automatic nudge counts but keeps the timer", [autoNudge.patch.stalled_nudges, "stall_timer_started_at" in autoNudge.patch], [1, false]);
  const manNudge = advanceOrder(st("awaiting_dealer_approval", { stalled_nudges: 1 }), { type: "nudged", target: "dealer", manual: true }, email);
  eq("manual nudge restarts the timer", [manNudge.patch.stalled_nudges, manNudge.patch.stall_timer_started_at], [0, NOW.toISOString()]);
  eq("nudge dealer refused while awaiting the supplier", throws(() => advanceOrder(st("awaiting_supplier"), { type: "nudged", target: "dealer", manual: true }, email)), true);
  eq("nudge supplier allowed while awaiting the dealer", advanceOrder(st("awaiting_dealer_approval"), { type: "nudged", target: "supplier", manual: true }, email).status, "awaiting_dealer_approval");

  eq("owner_changed on an open order", advanceOrder(st("ready"), { type: "owner_changed", ownerId: "o2" }, email).patch.owner_staff_id, "o2");
  eq("owner_changed refused when done", throws(() => advanceOrder(st("done"), { type: "owner_changed", ownerId: null }, email)), true);
  eq("cancelled with a reason", (() => { const a = advanceOrder(st("awaiting_supplier"), { type: "cancelled", reason: " Dealer went manual " }, email); return [a.status, a.patch.cancel_reason]; })(), ["cancelled", "Dealer went manual"]);
  eq("cancelled refused without a reason", throws(() => advanceOrder(st("ready"), { type: "cancelled", reason: "" }, email)), true);
  eq("cancelled refused when already cancelled", throws(() => advanceOrder(st("cancelled"), { type: "cancelled", reason: "x" }, email)), true);
  eq("no event moves a done order", (["created", "info_updated", "request_sent", "dealer_approved", "feed_id_entered", "cancelled"] as const).every((t) => t === "created" || throws(() => advanceOrder(st("done"), { type: t, fields: {}, threadId: null, via: "email", candidate: "x", reason: "x" } as unknown as OrderEvent, email))), true);

  // ── Stall rules ─────────────────────────────────────────────────────────
  const A = (s: OrderStatus, n = 0) => ({ status: s, stalled_nudges: n });
  eq("approval: 2 bd → nothing yet", stallActions(A("awaiting_dealer_approval"), 2, 2, {}), []);
  eq("approval: 3 bd → dealer follow-up", stallActions(A("awaiting_dealer_approval"), 3, 2, {}), ["dealer_followup"]);
  eq("approval: follow-up only once", stallActions(A("awaiting_dealer_approval", 1), 4, 2, {}), []);
  eq("approval: 6 bd → call approver task", stallActions(A("awaiting_dealer_approval", 1), 6, 2, {}), ["task_call_approver"]);
  eq("approval: call task only once", stallActions(A("awaiting_dealer_approval", 1), 9, 2, { callApproverTask: true }), []);
  eq("supplier: turnaround 3 → follow-up after 5 bd", [stallActions(A("awaiting_supplier"), 5, 3, {}), stallActions(A("awaiting_supplier"), 6, 3, {})], [[], ["supplier_followup"]]);
  eq("supplier: call supplier after turnaround + 5", stallActions(A("awaiting_supplier", 1), 9, 3, {}), ["task_call_supplier"]);
  eq("needs_info: escalate after 3 bd while the task is open", [stallActions(A("needs_info"), 4, 2, { needsInfoTaskOpen: true }), stallActions(A("needs_info"), 4, 2, { needsInfoTaskOpen: false }), stallActions(A("needs_info"), 4, 2, { needsInfoTaskOpen: true, escalated: true })], [["escalate_needs_info"], [], []]);
  eq("age colours", [ageColor(1, 2), ageColor(4, 2), ageColor(6, 2)], ["green", "amber", "red"]);

  // ── Business days ───────────────────────────────────────────────────────
  eq("2026 holidays: Thanksgiving, Memorial, observed July 4 (Fri Jul 3)", ["2026-11-26", "2026-05-25", "2026-07-03"].map((d) => usHolidays(2026).has(d)), [true, true, true]);
  eq("weekends + holidays aren't business days", [isBusinessDay("2026-10-24"), isBusinessDay("2026-11-26"), isBusinessDay("2026-10-21")], [false, false, true]);
  eq("Fri → Mon = 1 business day", businessDaysBetween("2026-10-23T17:00:00Z", "2026-10-26T17:00:00Z"), 1);
  eq("same day = 0", businessDaysBetween("2026-10-21T15:00:00Z", "2026-10-21T23:00:00Z"), 0);
  eq("Wed before Thanksgiving → Mon = 2 (Thu holiday, Fri counted)", businessDaysBetween("2026-11-25T18:00:00Z", "2026-11-30T18:00:00Z"), 2);
  eq("next business day due: Friday → Monday 17:00 PT", nextBusinessDayDue(new Date("2026-10-23T18:00:00Z")), "2026-10-27T00:00:00.000Z");

  // ── Detection: approvals ────────────────────────────────────────────────
  const quoted = `Approved!\n\nBill\n\nFrom: DealerAddendums Feeds <feeds@dealeraddendums.com>\nSent: Monday\nSubject: Inventory Feed Request\n\n${APPROVAL_INSTRUCTION}`;
  eq("latest reply text cuts Outlook's quoted history", latestReplyText(quoted), "Approved!\n\nBill");
  eq("cuts 'On … wrote:' and > lines", latestReplyText("yes approved\n\nOn Mon, Oct 19, 2026 at 3:48 PM Feeds <feeds@x.com> wrote:\n> Please Reply All and write APPROVED"), "yes approved");
  eq("cuts a mid-line '----- Original Message -----'", latestReplyText("Thanks Team Velocity Marketing--------------- Original Message ---------------From: x"), "Thanks Team Velocity Marketing");
  for (const [txt, want] of [
    ["APPROVED", "approved"], ["Approved.", "approved"], ["I approve this request", "approved"], ["Yes approved - thanks Bill", "approved"],
    ["ok to send", "approved"], ["Go ahead!", "approved"], ["approved, please proceed", "approved"],
    ["Not approved", "ambiguous"], ["I don't approve this", "ambiguous"], ["Please hold off for now", "ambiguous"], ["Who is this?", "ambiguous"],
    ["Do not go ahead until I talk to the GM", "ambiguous"], ["", "ambiguous"], ["preapproved credit offers", "ambiguous"],
  ] as [string, string][]) eq(`approval: "${txt}" → ${want}`, classifyApproval(txt), want);
  eq("the quoted instruction alone is never an approval", classifyApproval(latestReplyText(`Who do I talk to about this?\n\nFrom: Feeds\n${APPROVAL_INSTRUCTION}`)), "ambiguous");
  eq("custom phrase list", classifyApproval("Sounds good", ["sounds good"]), "approved");

  // ── Detection: Feed IDs (real supplier phrasing) ─────────────────────────
  for (const [txt, want] of [
    ["Collect data using the feed(s) configured below.\nFeed ID: MP6767\nOnce confirmed…", ["MP6767"]],
    ["I have enabled this feed under ID: MP12601.", ["MP12601"]],
    ["We already have a feed to Dealer Addendums for this location under the ID LITHIAVW01.", ["LITHIAVW01"]],
    ["This feed has been established under the ID CHARLOTT01.", ["CHARLOTT01"]],
    ["We have enabled the inventory export under the ID: OxmoorHyundai.", ["OxmoorHyundai"]],
    ["The Dealer ID is 48213 for the new export", ["48213"]],
    ["Please provide the store's unique Dealer ID once completed.", []],
    ["Your vAuto support case #08110489 has been closed. Account: MERCEDES-BENZ OF ESCONDIDO", []],
  ] as [string, string[]][]) eq(`feed id: "${txt.slice(0, 50)}…"`, extractFeedIds(txt), want);
  eq("supplier pattern wins (group 1)", extractFeedIds("Ref 99812 — store MP7001 is live", "\\b(MP\\d{3,6})\\b"), ["MP7001"]);
  eq("invalid supplier pattern ignored", [compilePattern("(["), extractFeedIds("Feed ID: AB123", "([")], [null, ["AB123"]]);

  // ── Detection: who + what ───────────────────────────────────────────────
  const ctx = { approverEmail: "bill@herzogmeier.com", dealerDomains: ["herzogmeier.com"], supplierEmails: ["support@teamvelocitymarketing.com"], supplierDomains: ["teamvelocitymarketing.com"] };
  eq("sender: approver / dealer domain / supplier / other", [
    classifySender("Bill@HerzogMeier.com", ctx), classifySender("gm@herzogmeier.com", ctx), classifySender("kate@teamvelocitymarketing.com", ctx), classifySender("x@gmail.com", ctx),
  ], ["dealer", "dealer", "supplier", "other"]);
  const order = { status: "awaiting_dealer_approval", feedIdPattern: null, ...ctx };
  eq("on order: approver says APPROVED", detectOnOrder({ from: "bill@herzogmeier.com", text: "APPROVED\n\nFrom: feeds" }, order).kind, "dealer_approved");
  eq("on order: approver asks a question → review dealer reply", detectOnOrder({ from: "bill@herzogmeier.com", text: "What does this cost?" }, order).kind, "review_dealer_reply");
  eq("on order: supplier's own 'Please REPLY ALL with APPROVED' request → supplier, no ID", detectOnOrder({ from: "support@teamvelocitymarketing.com", text: "Hi Bill, Team Velocity has received a request to send inventory to Dealer Addendums for Herzog-Meier Volkswagen. Please REPLY ALL with APPROVED for this request to be completed." }, order).kind, "supplier_no_id");
  eq("on order: supplier sends the ID", detectOnOrder({ from: "support@teamvelocitymarketing.com", text: "Done — enabled under the ID HMVW01." }, { ...order, status: "awaiting_supplier" }), { kind: "feed_id", candidates: ["HMVW01"], latest: "Done — enabled under the ID HMVW01.", supplier: { kind: "completion", caseNumber: null, cancellation: null } });
  eq("on order: somebody else → review reply", detectOnOrder({ from: "random@other.com", text: "approved" }, order).kind, "review_reply");
  eq("on order: dealer reply after approval → review reply", detectOnOrder({ from: "bill@herzogmeier.com", text: "approved" }, { ...order, status: "awaiting_supplier" }).kind, "review_reply");
  eq("mentions dealer (punctuation / case-insensitive)", [mentionsDealer("RE: Inventory Feed Request for: Herzog-Meier Volkswagen", null, "Herzog Meier Volkswagen"), mentionsDealer("Other store", "nothing", "Herzog Meier Volkswagen")], [true, false]);

  // ── PDF fill ────────────────────────────────────────────────────────────
  {
    const tpl = await samplePdfTemplate();
    eq("sample template fields", (await pdfFieldNames(tpl)).sort(), ["address", "approver_email", "approver_name", "dealer_id", "dealership", "destination", "signature"]);
    const r = await fillRequestPdf(tpl, { ...SAMPLE_PDF_FIELD_MAP, NotAField: "x", destination: "{{bogus.var}}" }, {
      "company.name": "Herzog-Meier Volkswagen", "company.address": "4275 SW 139th Way", "company.city": "Beaverton", "company.state": "OR", "company.zip": "97005",
      "company.dealer_id": "MP11922", "approver.name": "Bill Meier", "approver.email": "bill@herzogmeier.com",
    });
    const form = (await PDFDocument.load(r.bytes)).getForm();
    eq("PDF fill: values written", [form.getTextField("dealership").getText(), form.getTextField("address").getText(), form.getTextField("approver_email").getText()], ["Herzog-Meier Volkswagen", "4275 SW 139th Way, Beaverton, OR 97005", "bill@herzogmeier.com"]);
    eq("PDF fill: signature left blank for the dealer, form not flattened", [form.getTextField("signature").getText() ?? "", form.getFields().length], ["", 7]);
    eq("PDF fill: report (missing field, unknown variable)", [r.missingFields, r.unknownVars], [["NotAField"], ["bogus.var"]]);
  }

  // ── Templates ───────────────────────────────────────────────────────────
  {
    const db = fakeDb({ crm_email_templates: [
      { id: "g1", feed_kind: "request", supplier_company_id: null, archived: false, name: "Global", subject: "G", body_html: "g" },
      { id: "s1", feed_kind: "request", supplier_company_id: "sup-vauto", archived: false, name: "vAuto", subject: "V", body_html: "v" },
      { id: "old", feed_kind: "dealer_followup", supplier_company_id: null, archived: true, name: "Old", subject: "O", body_html: "o" },
    ] });
    eq("resolve: supplier override", (await resolveFeedTemplate(db, "request", "sup-vauto")).source, "supplier");
    eq("resolve: other supplier → global default", (await resolveFeedTemplate(db, "request", "sup-other")).id, "g1");
    eq("resolve: nothing in DB (archived ignored) → built-in", (await resolveFeedTemplate(db, "dealer_followup", null)).source, "built_in");
    const req = DEFAULT_FEED_TEMPLATES.request;
    const out = renderTemplate(req.body_html, { "company.name": "Sour Lake Motors", "company.city": "Sour Lake", "company.state": "TX", "supplier.name": "Autosoft", "approver.first_name": "Mike" }, { html: true });
    eq("built-in request: every token is known, ends with the APPROVED instruction", [out.unknown, out.text.includes("Reply All to this email and write APPROVED"), out.text.includes("Hello Autosoft Support and Mike")], [[], true, true]);
    eq("order number", orderNumber("1a2b3c4d-0000-0000-0000-000000000000"), "FO-1A2B3C");
  }

  // ── Inbound handler end-to-end (fake DB) ─────────────────────────────────
  {
    unregisterInboundEmailHandler("feeds");
    const now = new Date().toISOString();
    const db = fakeDb({
      crm_feed_orders: [
        { id: "ord-1", dealer_company_id: "co-hm", supplier_company_id: "sup-tv", status: "awaiting_dealer_approval", approver_name: "Bill Meier", approver_email: "bill@herzogmeier.com", email_thread_id: "th-1", owner_staff_id: "staff-1", stall_timer_started_at: now, stalled_nudges: 0, created_at: now },
        { id: "ord-1-d", parent_order_id: "ord-1", dealer_company_id: "co-hm", supplier_company_id: "sup-tv", status: "pending", supplier_fields: {}, owner_staff_id: "staff-1", stall_timer_started_at: now, stalled_nudges: 0, created_at: now },
      ],
      crm_feed_supplier_settings: [{ company_id: "sup-tv", request_method: "email", request_email: "support@teamvelocitymarketing.com", cc_emails: [], feed_id_pattern: null, typical_turnaround_days: 2 }],
      crm_contacts: [], crm_companies: [{ id: "co-hm", website: "https://www.herzogmeier.com" }], crm_company_directory: [{ id: "co-hm", name: "Herzog-Meier Volkswagen" }],
      crm_settings: [{ id: true, feed_approval_phrases: ["APPROVED", "approve", "approved", "ok to send", "yes approved", "go ahead"] }],
      crm_feed_order_events: [], crm_activities: [], crm_tasks: [], crm_feed_unmatched: [],
    });
    const ev = (id: string, from: string, text: string, thread = "th-1", subject = "RE: Inventory Feed Request for: Herzog-Meier Volkswagen"): InboundEmailEvent => ({
      email: { id, thread_id: thread, mailbox_id: "mb-feeds", graph_message_id: `g-${id}`, internet_message_id: null, in_reply_to: null, from_email: from, from_name: null, to: [], cc: [], subject, body_text: text, body_html: null, received_at: now, is_reply_all: true, has_attachments: false },
      thread: { id: thread, company_id: "co-hm", contact_id: null, subject, status: "open", internal: false, message_count: 2 },
      mailbox: { id: "mb-feeds", address: "feeds@dealeraddendums.com", purpose: "feeds" },
    });
    const o = () => db.rows("crm_feed_orders")[0];
    const d = () => db.rows("crm_feed_orders")[1];
    eq("inbound: supplier's own approval-request email → logged only, no task (it isn't a Feed ID reply)",
      [await handleFeedsEmail(ev("e0", "support@teamvelocitymarketing.com", "Please REPLY ALL with APPROVED for this request to be completed."), db), o().status, db.rows("crm_tasks").map((t: any) => t.kind)],
      ["approval_request", "awaiting_dealer_approval", []]);
    eq("inbound: approver's question → Review dealer reply task, status unchanged",
      [await handleFeedsEmail(ev("e1", "bill@herzogmeier.com", "Is there a cost?\n\nFrom: Feeds\nPlease Reply All and write APPROVED"), db), o().status, db.rows("crm_tasks").some((t: any) => t.kind === "feed_review_dealer_reply")],
      ["review_dealer_reply", "awaiting_dealer_approval", true]);
    eq("inbound: approver replies APPROVED → awaiting_supplier",
      [await handleFeedsEmail(ev("e2", "bill@herzogmeier.com", "Approved\n\nFrom: Feeds\nPlease Reply All and write APPROVED"), db), o().status, !!o().dealer_approved_at],
      ["dealer_approved", "awaiting_supplier", true]);
    eq("inbound: approval re-dispatched → ignored (idempotent on email id)", await handleFeedsEmail(ev("e2", "bill@herzogmeier.com", "Approved"), db), "duplicate");
    eq("inbound: supplier mail OUTSIDE the thread naming the dealer → Feed ID → confirm task",
      [await handleFeedsEmail(ev("e3", "kate@teamvelocitymarketing.com", "Herzog-Meier Volkswagen is set up under the ID HMVW01.", "th-other", "Herzog-Meier Volkswagen export"), db), o().status, d().status, d().feed_id_candidate, db.rows("crm_tasks").find((t: any) => t.kind === "feed_confirm_id")?.title],
      ["feed_id", "feed_id_received", "feed_id_received", "HMVW01", "Confirm Feed ID HMVW01"]);
    eq("inbound: status changes are events + timeline rows", [db.rows("crm_feed_order_events").filter((e: any) => ["dealer_approved", "feed_id_detected", "dealership_feed_id"].includes(e.type)).length, db.rows("crm_activities").every((a: any) => a.type === "feed_order" && a.company_id === "co-hm")], [3, true]);
    eq("inbound: closed tasks — approval closes the review task", db.rows("crm_tasks").filter((t: any) => t.status === "open").map((t: any) => t.kind), ["feed_confirm_id"]);
    eq("inbound: unrelated feeds@ mail → Unmatched", [await handleFeedsEmail(ev("e4", "someone@else.com", "hello", "th-x", "Question"), db), db.rows("crm_feed_unmatched").length], ["unmatched", 1]);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
