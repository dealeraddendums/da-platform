/* npm run test:crm-feed-suppliers — the three seeded feed suppliers (lib/crm/feeds/suppliers.ts)
   against their real, anonymized threads (scripts/fixtures/crm-feeds/*.json), no database or
   network: every inbound message goes through handleFeedsEmail() on the in-memory Supabase fake
   and must leave the order (and each of its dealerships) in the expected state with the expected
   Feed ID / case number / tasks / follow-up mail (mail + S3 are recorders via feedIo). Also: the
   supplier questions, the templates, the Autosoft PDF filled through the real request path (every
   mapped field checked; one form, one per dealership, one combined), a group order with several
   dealerships, Autosoft's Salesforce "on behalf of" sender, and a guard that no real dealer /
   person / ID from the source threads is in the fixtures.
     --write-example  also writes docs/feeds/suppliers/autosoft/data-transfer-form-filled-example.pdf */
/* eslint-disable @typescript-eslint/no-explicit-any */
delete process.env.ANTHROPIC_API_KEY;   // AI second opinion off: deterministic

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PDFDocument, PDFTextField } from "pdf-lib";
import { fakeDb } from "./crm-fake-supabase";
import { handleFeedsEmail } from "../lib/crm/feeds/inbound";
import { unregisterInboundEmailHandler, type InboundEmailEvent } from "../lib/crm/email-hooks";
import { applyOrderEvent, cancelOrder, createFeedOrder, feedIo, forwardSignedPdf, nudge, prepareRequest, sendRequest, updateOrderInfo } from "../lib/crm/feeds/orders";
import { SUPPLIER_PROFILES, supplierProfile, type SupplierProfile } from "../lib/crm/feeds/suppliers";
import { htmlToText } from "../lib/crm/email-html";
import {
  classifyApproval, classifySender, classifySupplierMessage, DEFAULT_APPROVAL_PHRASES, extractCaseNumber, extractFeedIds, findCancellationDeadline, latestReplyText,
  mapFeedIds, matchPdfsToDealerships, stripSupplierTokens, subjectHasCaseRef,
} from "../lib/crm/feeds/detect";
import { checkOrderFields, checkSupplierFields, feedIdField, parseExtraFields, supplierFieldContext } from "../lib/crm/feeds/extra-fields";
import { pdfFieldNames } from "../lib/crm/feeds/pdf";
import { findUnknownTokens } from "../lib/crm/template-vars";
import { composeEmail } from "../lib/crm/email-compose";
import { normalizeGraphMessage, skipReason } from "../lib/crm/inbox-message";

let fail = 0, pass = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`}`);
}

const ROOT = path.resolve(__dirname, "..");
const FIX = path.join(__dirname, "fixtures", "crm-feeds");
const BLANK_PDF = path.join(ROOT, "docs/feeds/suppliers/autosoft/data-transfer-form-blank.pdf");
type Msg = { id: string; direction: "inbound" | "outbound"; thread: string; receivedAt: string; from: string; fromName: string | null; sender?: string; to: string[]; cc: string[]; subject: string; bodyHtml: string; attachments?: { filename: string; contentType: string; isInline?: boolean }[]; expect?: any; reconstructed?: boolean };
type Roof = { key: string; name: string; city: string; state: string; website: string; address?: string; zip?: string; account?: string };
type Fixture = {
  supplier: string; dealer?: { name: string; city: string; state: string; website: string };
  /** Several dealerships on one request (a group's rooftops). */
  group?: { name: string; city: string; state: string }; dealerships?: Roof[];
  approver: { name: string; email: string; title?: string }; supplier_fields: Record<string, string>; messages: Msg[]; supplierFollowupAfter?: string; forwardAfter?: string[];
};
const load = (f: string): Fixture => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));

// ── Mail / S3 recorders ──────────────────────────────────────────────────────
type Sent = { mode: string; emailId?: string; to: string[]; cc: string[]; subject: string; body: string; attachments: string[] };
let sent: Sent[] = [];
let seq = 0;
let currentDb: any = null;
// Rendered exactly as the Inbox send path renders it (composeEmail: company / staff variables + the order's).
feedIo.send = (async (input: any) => {
  const c = await composeEmail({ subject: input.subject ?? "", bodyHtml: input.bodyHtml ?? "", companyId: input.companyId ?? "co-d", staffId: input.staffId, signature: false, extraContext: input.templateContext }, currentDb);
  sent.push({
    mode: input.mode, emailId: input.emailId, to: (input.to ?? []).map((r: any) => r.email), cc: (input.cc ?? []).map((r: any) => r.email),
    subject: c.subject, body: c.html, attachments: (input.attachments ?? []).map((a: any) => a.name),
  });
  return { emailId: `sent-${++seq}`, threadId: input.mode === "new" ? `T-sent-${seq}` : null };
}) as any;
feedIo.getObject = async (key: string) => (key.endsWith("blank.pdf") ? fs.readFileSync(BLANK_PDF) : Buffer.from("%PDF-1.4 signed"));
feedIo.putObject = async () => undefined;

// ── Fake DB for one fixture ──────────────────────────────────────────────────
// One dealership: the order is "ord" on company co-d with one child "ord-d". Several: the order
// is on the group company co-g, one child "ord-<key>" per rooftop on company co-<key>.
const roofsOf = (fx: Fixture): Roof[] => fx.dealerships ?? [{ key: "d", ...fx.dealer!, address: "100 Fixture Way", zip: "77659" }];
const coOf = (fx: Fixture, r: Roof) => (fx.dealerships ? `co-${r.key}` : "co-d");

function seedDb(fx: Fixture, profile: SupplierProfile, opts: { status?: string; pdfMode?: string; extraOrders?: { parent: any; child: any; name: string }[] } = {}) {
  const threads = Array.from(new Set(fx.messages.map((m) => m.thread)));
  const now = new Date().toISOString();
  const roofs = roofsOf(fx);
  const defs = profile.settings.extra_fields;
  const idField = feedIdField(defs);
  const answers = checkOrderFields(defs, fx.supplier_fields, roofs.map((r) => ({ name: r.name, fields: { ...(roofs.length === 1 ? fx.supplier_fields : {}), ...(r.account && idField ? { [idField.key]: r.account } : {}) } })));
  const parentCo = fx.group ? "co-g" : "co-d";
  const order = {
    id: "ord", dealer_company_id: parentCo, supplier_company_id: "sup", status: opts.status ?? "awaiting_dealer_approval", parent_order_id: null,
    approver_name: fx.approver.name, approver_email: fx.approver.email, approver_title: fx.approver.title ?? null, approver_phone: null,
    email_thread_id: "T0", owner_staff_id: "staff-1", initiated_by_staff_id: "staff-1", pdf_mode: opts.pdfMode ?? "per_dealership",
    supplier_fields: answers.request, metadata: {}, sent_at: fx.messages[0].receivedAt, stall_timer_started_at: now, stalled_nudges: 0, created_at: now,
  };
  const kids = roofs.map((r, i) => ({
    id: `ord-${r.key}`, parent_order_id: "ord", dealer_company_id: coOf(fx, r), supplier_company_id: "sup", status: "pending",
    supplier_fields: answers.dealerships[i], feed_id_candidate: idField ? answers.dealerships[i][idField.key] ?? null : null,
    owner_staff_id: "staff-1", stall_timer_started_at: now, stalled_nudges: 0, created_at: new Date(Date.now() + i).toISOString(),
  }));
  const extra = opts.extraOrders ?? [];
  return (currentDb = fakeDb({
    crm_companies: [
      ...(fx.group ? [{ id: "co-g", kind: "group", group_id: "grp-1" }] : []),
      ...roofs.map((r, i) => ({ id: coOf(fx, r), kind: "dealer", website: r.website, dealer_id: `dlr-${i + 1}` })),
      { id: "sup", kind: "feed_supplier", name: profile.name },
      ...extra.map((x) => ({ id: x.parent.dealer_company_id, kind: "dealer" })),
    ],
    crm_company_directory: [
      ...(fx.group ? [{ id: "co-g", kind: "group", name: fx.group.name, city: fx.group.city, state: fx.group.state, phone: "+14095550100", group_id: "grp-1" }] : []),
      ...roofs.map((r, i) => ({ id: coOf(fx, r), kind: "dealer", name: r.name, dealer_text_id: `D-FIXTURE${i || ""}`, city: r.city, state: r.state, phone: `+1409555010${i}`, dealer_id: `dlr-${i + 1}`, parent_group_id: fx.group ? "grp-1" : null, active: true })),
      { id: "sup", name: profile.name },
      ...extra.map((x) => ({ id: x.parent.dealer_company_id, kind: "dealer", name: x.name })),
    ],
    dealers: roofs.map((r, i) => ({ id: `dlr-${i + 1}`, address: r.address ?? "100 Fixture Way", zip: r.zip ?? "77659", inventory_provider: null, inventory_provider_is_dms: false })),
    groups: [{ id: "grp-1", address: "1 Group Plaza", zip: "77659" }],
    profiles: [{ id: "staff-1", full_name: "Casey Lane", email: "casey@dealeraddendums.com" }],
    crm_staff_profiles: [{ staff_id: "staff-1", full_name: "Casey Lane" }],
    crm_feed_supplier_settings: [{ company_id: "sup", ...profile.settings, needs_review: false, pdf_template_s3_key: profile.pdfTemplate ? "crm/feed-suppliers/autosoft/blank.pdf" : null }],
    crm_feed_orders: [order, ...kids, ...extra.flatMap((x) => [x.parent, x.child])],
    crm_email_threads: threads.map((t) => ({ id: t, feed_order_id: t === "T0" ? "ord" : null, company_id: null })),
    crm_emails: fx.messages.map((m) => ({ id: m.id, thread_id: m.thread, subject: m.subject, received_at: m.receivedAt, from_email: m.from, direction: m.direction })),
    crm_email_attachments: fx.messages.flatMap((m) => (m.attachments ?? []).map((a) => ({ email_id: m.id, filename: a.filename, content_type: a.contentType, size: 1000, s3_key: `crm/co-d/email/${m.id}/${a.filename}`, is_inline: !!a.isInline }))),
    crm_email_templates: Object.entries(profile.templates).map(([kind, t]) => ({ id: `tpl-${kind}`, feed_kind: kind, supplier_company_id: "sup", archived: false, name: t!.name, subject: t!.subject, body_html: t!.body_html })),
    crm_mailboxes: [{ id: "mb-feeds", address: "feeds@dealeraddendums.com", purpose: "feeds", active: true }],
    crm_contacts: [], crm_settings: [{ id: true, feed_approval_phrases: DEFAULT_APPROVAL_PHRASES }],
    crm_feed_order_events: [], crm_activities: [], crm_tasks: [], crm_feed_unmatched: [], crm_company_files: [],
  }));
}

const event = (m: Msg): InboundEmailEvent => ({
  email: {
    id: m.id, thread_id: m.thread, mailbox_id: "mb-feeds", graph_message_id: `g-${m.id}`, internet_message_id: null, in_reply_to: null,
    from_email: m.from, from_name: m.fromName, sender_email: m.sender ?? null, to: m.to.map((email) => ({ email, name: null })), cc: m.cc.map((email) => ({ email, name: null })),
    subject: m.subject, body_text: htmlToText(m.bodyHtml), body_html: m.bodyHtml, received_at: m.receivedAt, is_reply_all: true, has_attachments: !!m.attachments?.length,
  },
  thread: { id: m.thread, company_id: null, contact_id: null, subject: m.subject, status: "open", internal: false, message_count: 2 },
  mailbox: { id: "mb-feeds", address: "feeds@dealeraddendums.com", purpose: "feeds" },
});

const ordRow = (db: any, id = "ord") => db.rows("crm_feed_orders").find((o: any) => o.id === id);
const openTasks = (db: any) => db.rows("crm_tasks").filter((t: any) => t.status === "open").map((t: any) => t.kind);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function runFixture(file: string) {
  const fx = load(file);
  const profile = supplierProfile(fx.supplier)!;
  const db = seedDb(fx, profile);
  const roofs = roofsOf(fx);
  sent = [];
  const order = () => ordRow(db);
  const kid = (key = roofs[0].key) => ordRow(db, `ord-${key}`);
  console.log(`\n── ${fx.supplier} (${file}${roofs.length > 1 ? `, ${roofs.length} dealerships` : ""}) ──`);
  for (const m of fx.messages) {
    if (m.direction === "inbound" && m.expect) {
      const x = m.expect;
      const label = `${fx.supplier} ${m.id} (${m.from.split("@")[0]}@…${m.sender ? ` for ${m.sender.split("@")[0]}@…` : ""})`;
      const r = await handleFeedsEmail(event(m), db);
      const o = order();
      eq(`${label}: result / status`, [r, o.status], [x.result, x.status]);
      if (x.feedId) eq(`${label}: Feed ID candidate on the dealership`, [kid().status, kid().feed_id_candidate], ["feed_id_received", x.feedId]);
      if (x.dealerships) eq(`${label}: each dealership's status + Feed ID`, Object.fromEntries(Object.keys(x.dealerships).map((k) => [k, [kid(k).status, kid(k).feed_id_candidate]])), x.dealerships);
      if (x.confirmTitles) eq(`${label}: one Confirm task per dealership, naming it`, db.rows("crm_tasks").filter((t: any) => t.kind === "feed_confirm_id" && t.status === "open").map((t: any) => t.title).sort(), [...x.confirmTitles].sort());
      if (x.caseNumber) eq(`${label}: case number on the order`, o.metadata?.case_number, x.caseNumber);
      if (x.openTasks) eq(`${label}: open tasks`, openTasks(db).sort(), [...x.openTasks].sort());
      if (x.mailsSent != null) eq(`${label}: mail sent so far`, sent.length, x.mailsSent);
      if (x.lastMail) {
        const last = sent[sent.length - 1];
        eq(`${label}: follow-up = reply all on the supplier's own message, to the approver`, [last?.mode, last?.emailId, last?.to], [x.lastMail.mode, x.lastMail.replyToMessage, x.lastMail.to]);
        eq(`${label}: follow-up wording`, last?.body.includes(x.lastMail.bodyIncludes), true);
      }
      if (x.cancellationIncludes) eq(`${label}: cancellation deadline captured`, String(o.metadata?.cancellation_deadline?.text ?? "").includes(x.cancellationIncludes), true);
      if (x.latestStartsWith) eq(`${label}: newest text after cleaning`, latestReplyText(htmlToText(m.bodyHtml)).startsWith(x.latestStartsWith), true);
      if (x.signedPdf) eq(`${label}: signed PDF on the order + company files`, [String(o.signed_pdf_s3_key).endsWith(x.signedPdf), db.rows("crm_company_files").some((f: any) => f.filename === x.signedPdf)], [true, true]);
      if (x.signedPdfs) {
        eq(`${label}: each signed form placed on its dealership (by filename)`, Object.fromEntries(Object.keys(x.signedPdfs).map((k) => [k, String(kid(k).signed_pdf_s3_key ?? "").split("/").pop()])), x.signedPdfs);
        eq(`${label}: …and in that dealership's Files`, Object.keys(x.signedPdfs).every((k) => db.rows("crm_company_files").some((f: any) => f.filename === x.signedPdfs[k] && f.company_id === kid(k).dealer_company_id)), true);
      }
    }
    if (m.id === fx.supplierFollowupAfter) {
      await nudge(db, "ord", "supplier", "staff-1", true);
      const s = sent[sent.length - 1];
      eq(`${fx.supplier}: supplier follow-up is a NEW email to the supplier only, quoting the case`, [s.mode, s.to, s.cc, s.subject.includes(`case# ${order().metadata.case_number}`)], ["new", [profile.settings.request_email], [], true]);
    }
    if (fx.forwardAfter?.includes(m.id)) {
      const r = await forwardSignedPdf(db, "ord", "staff-1");
      const s = sent[sent.length - 1];
      eq(`${fx.supplier}: Forward to supplier → ONE new email to ${profile.settings.request_email} with every dealership's signed form`, [s.mode, s.to, s.attachments.length, s.subject, r.missing], ["new", [profile.settings.request_email], roofs.length, `Activation Rqst - Dealer Addendums - Inventory Feed Request for: ${roofs.map((x) => x.name).join(" and ")}`, []]);
      eq(`${fx.supplier}: forwarding closes the forward task`, openTasks(db).includes("feed_forward_signed_pdf"), false);
    }
  }
  const linked = db.rows("crm_email_threads").filter((t: any) => t.feed_order_id === "ord").map((t: any) => t.id).sort();
  // Ours, the supplier's own approval / case threads, the notices — all found from any of them later.
  eq(`${fx.supplier}: every thread of the conversation is linked to the order`, linked, Array.from(new Set(fx.messages.map((m) => m.thread))).sort());
  return { fx, profile, db };
}

async function main() {
  unregisterInboundEmailHandler("feeds");

  // ── Cleaning on real phrasing ───────────────────────────────────────────
  eq("banner: Team Velocity's one-line EXTERNAL box is stripped",
    latestReplyText("EXTERNAL Organization This is an external message sent from outside of our organization\nApproved. Please proceed."), "Approved. Please proceed.");
  eq("banner: Proofpoint preview + banner dropped, the real text kept",
    latestReplyText("I approve. Marcus Hale, F&I…\nZjQcmQRYFpfptBannerStart\nThis Message Is From an External Sender\nPlease use caution clicking links or opening attachments unless you recognize the sender and are confident the content is safe.\n\nZjQcmQRYFpfptBannerEnd\nI approve.\n\nMarcus Hale"), "I approve.\n\nMarcus Hale");
  eq("wrapped links: Safelinks / urldefense / linkprotect URLs removed",
    latestReplyText("Approved. See MapleGroveVW.example (https://nam11.safelinks.protection.outlook.com/?url=https%3A%2F%2Flinkprotect.cudasvc.com%2Fx&data=1) and <https://urldefense.com/v3/__https://x__;!!y$>"), "Approved. See MapleGroveVW.example and");
  eq("signature: cut at the sign-off line", latestReplyText("Filename: 41872.csv\n\nThank you,\n\nJordan Blake\nID: XX999"), "Filename: 41872.csv");
  eq("quote: Salesforce '--- Forwarded Message ---' cuts", latestReplyText("Wade,\nresubmit please.\n--------------- Forwarded Message ---------------\nFrom: x\nAPPROVED"), "Wade,\nresubmit please.");
  eq("approval phrases (spec list) incl. 'you have my approval'", ["Approved. Please proceed.", "I approve.", "You have my approval", "ok to send", "We do not approve"].map((t) => classifyApproval(t)), ["approved", "approved", "approved", "approved", "ambiguous"]);

  // ── Supplier signals ────────────────────────────────────────────────────
  const tv = supplierProfile("Team Velocity")!, va = supplierProfile("Vauto")!, as = supplierProfile("Autosoft")!;
  eq("Team Velocity Feed ID from the filename", extractFeedIds("I have the file setup to go out with tonight's update.\n\nFilename: 41872.csv", tv.settings.feed_id_pattern), ["41872"]);
  eq("vAuto Feed ID", extractFeedIds("The export for Harbor Point Land Rover is enabled,  ID: MP48213.", va.settings.feed_id_pattern), ["MP48213"]);
  eq("Autosoft activation: every code, split on '/'", [extractFeedIds("Hello,\n\nDealerAddendums has been activated for CEDB17/CEDB75", as.settings.feed_id_pattern), extractFeedIds("DealerAddendums has been activated for CEDB17", as.settings.feed_id_pattern)], [["CEDB17", "CEDB75"], ["CEDB17"]]);
  eq("vAuto case number: reply body and notice subject", [extractCaseNumber(null, "case# 08274519 has been created", va.settings.case_number_pattern), extractCaseNumber("Your vAuto support case #08274519 has been opened", "", va.settings.case_number_pattern)], ["08274519", "08274519"]);
  eq("Team Velocity case notice subject", extractCaseNumber("Team Velocity Case Case - 00412233 Created: Inventory Feed Request for: X", "", tv.settings.case_number_pattern), "00412233");
  eq("Autosoft case reference = the Salesforce ref token", extractCaseNumber("RE: Inventory Feed Request for: Cedar Bend Motors??    [ ref:!00Df20Cce8.!500iL0FixT01:ref ]", "", as.settings.case_number_pattern), "!00Df20Cce8.!500iL0FixT01");
  eq("subject without the suppliers' ticket tokens", [
    stripSupplierTokens("RE: Inventory Feed Request for: Cedar Bend Motors??    [ ref:!00Df20Cce8.!500iL0FixT01:ref ]"),
    stripSupplierTokens("RE: Inventory Feed Request for: Harbor Point Land Rover?? [ thread::Zml4dHVyZVZBdGhyZWFkMDE:: ]"),
  ], ["RE: Inventory Feed Request for: Cedar Bend Motors", "RE: Inventory Feed Request for: Harbor Point Land Rover"]);
  eq("case reference in a subject (whole token only)", [
    subjectHasCaseRef("RE: X [ ref:!00Df20Cce8.!500iL0FixT01:ref ]", ["!00Df20Cce8.!500iL0FixT01"]),
    subjectHasCaseRef("Your vAuto support case #08274519 has been closed", ["08274519"]),
    subjectHasCaseRef("Invoice 1082745190", ["08274519"]),
  ], [true, true, false]);
  eq("cancellation sentence: Team Velocity", findCancellationDeadline("Please REPLY ALL with APPROVED. If we do not receive approval by end of day today, we will cancel this request. Thank you", tv.settings.cancellation_patterns), "If we do not receive approval by end of day today, we will cancel this request.");
  eq("cancellation sentence: vAuto", findCancellationDeadline("Kindly reply. Please note if approval is not received within 3 Business days, this case will be closed. You may submit…", va.settings.cancellation_patterns), "Please note if approval is not received within 3 Business days, this case will be closed.");
  eq("no cancellation in a plain approval request", findCancellationDeadline("Please REPLY ALL with APPROVED for this request to be completed."), null);
  eq("supplier message kinds", [
    classifySupplierMessage("Team Velocity received a request… The file has been setup but is currently disabled as we have not received dealership approval. Please REPLY ALL with approved."),
    classifySupplierMessage("The export for X is enabled, ID: MP1. **Please note that this case is now closed"),
    classifySupplierMessage("Thanks for contacting vAuto Client Care!", "Your vAuto support case #08274519 has been opened"),
    classifySupplierMessage("DealerAddendums has been activated for CEDB17/CEDB75"),
    classifySupplierMessage("Unfortunately, the Data Authorization form indicate… resubmit to us."),
    classifySupplierMessage("Filename: 41872.csv", "Re: DEALER APPROVAL REQUIRED RE: Inventory Feed Request for: X"),
  ], ["approval_request", "completion", "acknowledgement", "completion", "other", "other"]);

  // ── From / sender: Salesforce writing on Autosoft's behalf ──────────────
  {
    const sctx = { approverEmail: "wade@cedarbendtrucks.example", dealerDomains: ["cedarbendtrucks.example"], supplierEmails: ["dcsconnect@autosoftdms.com"], supplierDomains: ["autosoftdms.com"] };
    eq("sender: noreply@salesforce.com on behalf of dcsconnect@ → supplier (either way round)", [
      classifySender("noreply@salesforce.com", sctx, "dcsconnect@autosoftdms.com"), classifySender("dcsconnect@autosoftdms.com", sctx, "noreply@salesforce.com"), classifySender("noreply@salesforce.com", sctx, null),
    ], ["supplier", "supplier", "other"]);
    const msg = (from: string, sender: string) => ({ id: "g1", from: { emailAddress: { address: from, name: null } }, sender: { emailAddress: { address: sender } }, subject: "x", body: { contentType: "text", content: "x" } });
    const rules = { ignoreSenders: ["noreply@", "no-reply"], keepSenders: ["dcsconnect@autosoftdms.com", "autosoftdms.com"] };
    eq("ignore list: a feed supplier in From OR Sender beats noreply@", [
      skipReason(msg("noreply@salesforce.com", "dcsconnect@autosoftdms.com"), "feeds@dealeraddendums.com", rules),
      skipReason(msg("noreply@salesforce.com", "noreply@salesforce.com"), "feeds@dealeraddendums.com", rules),
      skipReason(msg("noreply@salesforce.com", "dcsconnect@autosoftdms.com"), "feeds@dealeraddendums.com", { ignoreSenders: rules.ignoreSenders }),
    ], [null, "ignored sender", "ignored sender"]);
    eq("normalized: sender kept only when it isn't the From address", [normalizeGraphMessage(msg("noreply@salesforce.com", "dcsconnect@autosoftdms.com"), "feeds@dealeraddendums.com").sender?.email, normalizeGraphMessage(msg("a@b.com", "a@b.com"), "feeds@dealeraddendums.com").sender], ["dcsconnect@autosoftdms.com", null]);
  }

  // ── Several dealerships: mapping IDs and forms ──────────────────────────
  {
    const two = [{ id: "m", name: "Cedar Bend Motors", account: "CEDB17" }, { id: "f", name: "Cedar Bend Ford", account: "CEDB75" }];
    eq("map IDs by account (Autosoft): each code to its dealership, unknown code flagged", mapFeedIds(["CEDB17", "CEDB75", "ZZZZ99"], two, ""), { mapped: [{ dealershipId: "m", feedId: "CEDB17" }, { dealershipId: "f", feedId: "CEDB75" }], unmatched: ["ZZZZ99"], others: [] });
    eq("map IDs by account: case-insensitive", mapFeedIds(["cedb75"], two, "").mapped, [{ dealershipId: "f", feedId: "CEDB75" }]);
    eq("map IDs, one dealership: the first, the rest noted", mapFeedIds(["MP1", "MP2"], [{ id: "x", name: "Harbor Point Land Rover" }], ""), { mapped: [{ dealershipId: "x", feedId: "MP1" }], unmatched: [], others: ["MP2"] });
    const noAcct = two.map(({ id, name }) => ({ id, name }));
    eq("map IDs, several, no accounts: by the dealership named beside the ID",
      mapFeedIds(["MP101", "MP102"], noAcct, "The export for Cedar Bend Ford is enabled, ID: MP101.\nThe export for Cedar Bend Motors is enabled, ID: MP102."),
      { mapped: [{ dealershipId: "f", feedId: "MP101" }, { dealershipId: "m", feedId: "MP102" }], unmatched: [], others: [] });
    eq("map IDs, several, no names beside them → staff map them", mapFeedIds(["MP101", "MP102"], noAcct, "Both exports are enabled: MP101 / MP102").unmatched, ["MP101", "MP102"]);
    const files = ["DEALER ADDENDUMS-AUTOSOFT DATA TRANSFER CEDAR BEND MOTOR CO.pdf", "DealerAddendums - Autosoft Data Transfer Form CEDAR BEND FORD.pdf", "scan001.pdf"];
    eq("signed forms → dealerships by filename ('MOTOR CO' = Motors; the shared 'Cedar Bend' doesn't decide)", matchPdfsToDealerships(files, two), { byDealership: { m: 0, f: 1 }, unplaced: [2], best: 0 });
    eq("signed form naming the account", matchPdfsToDealerships(["form CEDB75.pdf", "form.pdf"], two).byDealership, { f: 0 });
    eq("signed form naming both stays unplaced", matchPdfsToDealerships(["Cedar Bend Motors and Ford.pdf"], two).unplaced, [0]);
  }

  // ── The three threads end-to-end ────────────────────────────────────────
  await runFixture("team-velocity.json");
  await runFixture("vauto.json");
  const { fx: asFx, db: asDb } = await runFixture("autosoft.json");

  // Staff confirm each Autosoft dealership; the order is done once both are assigned.
  {
    await applyOrderEvent(asDb, "ord-motors", { type: "feed_id_confirmed", feedId: "CEDB17", staffId: "staff-1" }, "staff-1");
    eq("Autosoft: one dealership confirmed → it's assigned, the order still waits for the other", [ordRow(asDb, "ord-motors").status, ordRow(asDb).status], ["assigned", "feed_id_received"]);
    await applyOrderEvent(asDb, "ord-ford", { type: "feed_id_confirmed", feedId: "CEDB75", staffId: "staff-1" }, "staff-1");
    eq("Autosoft: both confirmed → the order is done, its confirm tasks closed", [ordRow(asDb).status, openTasks(asDb).filter((k: string) => k === "feed_confirm_id").length], ["done", 0]);
    eq("Autosoft: dealership events land on that dealership's timeline", asDb.rows("crm_activities").filter((a: any) => a.metadata?.event === "feed_id_confirmed").map((a: any) => a.company_id).sort(), ["co-ford", "co-motors"]);
  }

  // An activation naming a code no dealership on the order has → flagged, the other still offered.
  {
    const db = seedDb(asFx, as, { status: "awaiting_supplier" });
    const m = asFx.messages.find((x) => x.id === "as-4")!;
    const r = await handleFeedsEmail(event({ ...m, id: "as-4b", bodyHtml: m.bodyHtml.replace("CEDB17/CEDB75", "CEDB17/ZZZZ99") }), db);
    const review = db.rows("crm_tasks").find((t: any) => t.kind === "feed_review_supplier_reply");
    eq("Autosoft: 'activated for CEDB17/ZZZZ99' → Motors offered CEDB17, Ford still waiting, ZZZZ99 flagged for review",
      [r, ordRow(db, "ord-motors").status, ordRow(db, "ord-ford").status, String(review?.title ?? "").includes("ZZZZ99"), ordRow(db).metadata.unmatched_feed_ids],
      ["feed_id", "feed_id_received", "pending", true, ["ZZZZ99"]]);
    await cancelOrder(db, "ord-ford", "Ford isn't going automatic", "staff-1");
    await applyOrderEvent(db, "ord-motors", { type: "feed_id_confirmed", feedId: "CEDB17", staffId: "staff-1" }, "staff-1");
    eq("dropping one dealership + confirming the other → the order is done", [ordRow(db, "ord-ford").status, ordRow(db).status], ["cancelled", "done"]);
  }
  {
    const db = seedDb(asFx, as, { status: "awaiting_supplier" });
    await cancelOrder(db, "ord", "Dealer went manual", "staff-1");
    eq("cancelling the order cancels its dealerships, keeping the staff's reason", [ordRow(db).status, ordRow(db).cancel_reason, ordRow(db, "ord-motors").status, ordRow(db, "ord-ford").status], ["cancelled", "Dealer went manual", "cancelled", "cancelled"]);
  }

  // Two SEPARATE open orders, one Autosoft message naming both stores: a person links it.
  {
    const single: Fixture = { ...asFx, group: undefined, dealerships: [asFx.dealerships![0]] };
    const db = seedDb(single, as, { status: "awaiting_supplier", extraOrders: [{
      parent: { id: "ord-2", dealer_company_id: "co-ford", supplier_company_id: "sup", status: "awaiting_supplier", parent_order_id: null, approver_email: asFx.approver.email, email_thread_id: "T9", metadata: {}, supplier_fields: {} },
      child: { id: "ord-2-d", parent_order_id: "ord-2", dealer_company_id: "co-ford", supplier_company_id: "sup", status: "pending", supplier_fields: {} },
      name: "Cedar Bend Ford",
    }] });
    eq("Autosoft: one reply naming two separate open orders → Unmatched (never guessed)", await handleFeedsEmail(event(asFx.messages.find((m) => m.id === "as-2")!), db), "unmatched");
  }

  // ── Starting a group order ──────────────────────────────────────────────
  {
    const db = seedDb(asFx, as, { status: "ready" });
    db.rows("crm_feed_orders").splice(0);   // no orders yet
    const r = await createFeedOrder(db, {
      dealerCompanyId: "co-g", supplierCompanyId: "sup", source: "call", initiatedBy: "staff-1", approverName: asFx.approver.name, approverEmail: asFx.approver.email,
      supplierFields: { go_dealer: "N" }, dealershipCompanyIds: ["co-motors", "co-ford"], dealershipFields: { "co-motors": { autosoft_account: "cedb17" }, "co-ford": { autosoft_account: "cedb75" } },
    });
    const kids = db.rows("crm_feed_orders").filter((o: any) => o.parent_order_id === r.order.id);
    eq("group order: one parent (ready) + one pending child per rooftop, Feed ID pre-filled from the Autosoft account",
      [r.order.status, r.order.dealer_company_id, r.order.supplier_fields, kids.map((k: any) => [k.dealer_company_id, k.status, k.supplier_fields, k.feed_id_candidate])],
      ["ready", "co-g", { go_dealer: "N", transfer_row: "asis_vehinv2" }, [["co-motors", "pending", { autosoft_account: "CEDB17" }, "CEDB17"], ["co-ford", "pending", { autosoft_account: "CEDB75" }, "CEDB75"]]]);
    const busy = await createFeedOrder(db, { dealerCompanyId: "co-g", supplierCompanyId: "sup", source: "call", initiatedBy: "staff-1", dealershipCompanyIds: ["co-ford", "co-motors"] }).catch(errText);
    eq("group order: rooftops already on an open order are refused, naming them", String(busy).startsWith("Already on an open feed order: Cedar Bend Motors"), true);
    eq("group order: only the group's own rooftops", await createFeedOrder(db, { dealerCompanyId: "co-g", source: "call", dealershipCompanyIds: ["co-elsewhere"] }).catch(errText), "Some of those dealerships aren't in this group");
    eq("group order: a bad account on one rooftop is a 400 naming it", await createFeedOrder(seedDbEmpty(), { dealerCompanyId: "co-g", supplierCompanyId: "sup", source: "call", dealershipCompanyIds: ["co-ford"], dealershipFields: { "co-ford": { autosoft_account: "12345" } } }).catch(errText), "Autosoft account number: \"12345\" doesn't look right (the dealer's Autosoft Customer ID — four letters and two digits, e.g. ABCD17; the dealer can give it to you)");
    const gap = await createFeedOrder(seedDbEmpty(), { dealerCompanyId: "co-g", supplierCompanyId: "sup", source: "call", initiatedBy: "staff-1", approverName: "Wade", approverEmail: "wade@cedarbendtrucks.example", dealershipCompanyIds: ["co-motors", "co-ford"], dealershipFields: { "co-motors": { autosoft_account: "CEDB17" } } });
    eq("group order: a rooftop without its account → Needs info, the task names the rooftop", [gap.order.status, String(currentDb.rows("crm_tasks").find((t: any) => t.kind === "feed_get_info")?.description).includes("autosoft account number (Cedar Bend Ford)")], ["needs_info", true]);
    // Changing a pending dealership's account moves its pre-filled Feed ID with it.
    const kidFord = kids.find((k: any) => k.dealer_company_id === "co-ford");
    await updateOrderInfo(db, r.order.id, { dealership_fields: { [kidFord.id]: { autosoft_account: "CEDB76" } } }, "staff-1");
    eq("editing a dealership's account updates its pre-filled Feed ID", [ordRow(db, kidFord.id).supplier_fields.autosoft_account, ordRow(db, kidFord.id).feed_id_candidate], ["CEDB76", "CEDB76"]);
  }

  // ── Sending ─────────────────────────────────────────────────────────────
  {
    const fx = load("vauto.json");
    const db = seedDb(fx, va, { status: "ready" });
    ordRow(db).email_thread_id = null;
    sent = [];
    await sendRequest(db, "ord", "staff-1");
    const s = sent[0];
    eq("vAuto request: a NEW thread, approver + vat.support, our standard subject, 'I approve' instruction",
      [s.mode, s.to, s.cc, s.subject, s.body.includes("<strong>I approve</strong>")], ["new", [fx.approver.email], ["vat.support@coxautoinc.com"], "Inventory Feed Request for: Harbor Point Land Rover", true]);
    eq("vAuto request: the order now waits on the dealer, on the request's own new thread", [ordRow(db).status, String(ordRow(db).email_thread_id).startsWith("T-sent-")], ["awaiting_dealer_approval", true]);
    eq("vAuto request: Dealership / Location lines as in the real email", s.body.includes("Dealership: Harbor Point Land Rover<br>Location: Southport, NC"), true);
  }
  {
    const fx = load("team-velocity.json");
    const db = seedDb(fx, tv, { status: "ready" });
    sent = [];
    await sendRequest(db, "ord", "staff-1");
    eq("Team Velocity request: two addressed sections (supplier, then the approver's Reply All)",
      [sent[0].body.indexOf("<strong>Team Velocity Support:</strong>") > 0, sent[0].body.indexOf("<strong>Dan:</strong>") > sent[0].body.indexOf("Team Velocity Support:"), sent[0].body.includes("<strong>Reply All</strong>")], [true, true, true]);
  }
  {
    // One Team Velocity request for two of a group's rooftops: one email listing both.
    const fx: Fixture = { ...load("team-velocity.json"), dealer: undefined, group: asFx.group, dealerships: asFx.dealerships!.map(({ account: _a, ...r }) => r) };
    const db = seedDb(fx, tv, { status: "ready" });
    sent = [];
    await sendRequest(db, "ord", "staff-1");
    eq("group request: ONE email, subject names both, body lists each dealership + location",
      [sent.length, sent[0].subject, sent[0].body.includes("Dealership: Cedar Bend Motors<br>Location: Cedar Bend, TX<br><br>Dealership: Cedar Bend Ford<br>Location: Cedar Bend, TX"), sent[0].body.includes("Please add Cedar Bend Motors and Cedar Bend Ford to the Dealer Addendums")],
      [1, "Inventory Feed Request for: Cedar Bend Motors and Cedar Bend Ford", true, true]);
  }

  // ── Autosoft: questions, PDF through the real request path ──────────────
  {
    const defs = as.settings.extra_fields;
    eq("Autosoft questions: account required, upper-cased, defaults for GO / row", checkSupplierFields(defs, { autosoft_account: " cedb17 " }), { values: { autosoft_account: "CEDB17", go_dealer: "N", transfer_row: "asis_vehinv2" }, errors: [], missing: [] });
    eq("Autosoft questions: missing account → Needs info", checkSupplierFields(defs, {}).missing, ["Autosoft account number"]);
    eq("Autosoft questions: bad account format", checkSupplierFields(defs, { autosoft_account: "12345" }).errors.length, 1);
    eq("Autosoft questions: GoBatch for a non-GO dealer is refused (Autosoft's 2026-10-21 rejection)", checkSupplierFields(defs, { autosoft_account: "CEDB17", transfer_row: "gobatch" }).errors, ["GoBatch is only for Autosoft GO dealers — Autosoft rejects the form otherwise. Pick ASIS_VehInv2."]);
    eq("Autosoft questions: years of history only with GoBatch", [
      checkSupplierFields(defs, { autosoft_account: "CEDB17", historical_years: "3" }).values.historical_years ?? null,
      checkSupplierFields(defs, { autosoft_account: "CEDB17", go_dealer: "Y", transfer_row: "gobatch", historical_years: "3" }).values.historical_years,
    ], [null, "3"]);
    eq("Autosoft questions: the account is per dealership and IS the Feed ID", [feedIdField(defs)?.key, checkOrderFields(defs, { go_dealer: "N" }, [{ name: "Cedar Bend Motors", fields: { autosoft_account: "CEDB17" } }, { name: "Cedar Bend Ford", fields: {} }]).missing], ["autosoft_account", ["Autosoft account number (Cedar Bend Ford)"]]);
    const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as any)[k])])) : v;
    eq("Autosoft questions survive the jsonb round trip (all four, Y/N options, the per-dealership / Feed ID flags)", canon(parseExtraFields(JSON.parse(JSON.stringify(defs)))), canon(defs));
    eq("choice → per-option X variables", supplierFieldContext(defs, { autosoft_account: "CEDB17", go_dealer: "N", transfer_row: "asis_vehinv2" })["order.supplier_fields.transfer_row.asis_vehinv2"], "X");

    const blankFields = await pdfFieldNames(fs.readFileSync(BLANK_PDF));
    eq("Autosoft field map: every mapped field exists in the blank form", Object.keys(as.settings.pdf_field_map).filter((f) => !blankFields.includes(f)), []);

    const today = new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "2-digit", day: "2-digit", year: "numeric" });
    const values = async (bytes: Buffer) => { const form = (await PDFDocument.load(bytes)).getForm(); return (n: string) => (form.getField(n) as PDFTextField).getText() ?? ""; };

    // One dealership: the single form.
    const one: Fixture = { ...asFx, group: undefined, dealerships: undefined, dealer: { name: "Cedar Bend Motors", city: "Cedar Bend", state: "TX", website: "https://www.cedarbendtrucks.example" }, supplier_fields: { autosoft_account: "cedb17", go_dealer: "N" } };
    const db = seedDb(one, as, { status: "ready" });
    const prep = await prepareRequest(db, ordRow(db));
    eq("Autosoft request: PDF method, request_pdf template, approver only (no Cc to Autosoft), one form, no problems", [prep.method, prep.kind, prep.to.map((t) => t.email), prep.cc, prep.pdfs.length, prep.problems], ["pdf", "request_pdf", [one.approver.email], [], 1, []]);
    const pdf = prep.pdfs[0];
    const val = await values(pdf.bytes);
    const want: Record<string, string> = {
      "Dealership Name": "Cedar Bend Motors", "Date": today, "Address": "100 Fixture Way", "City": "Cedar Bend", "State": "TX", "Zip": "77659",
      "Contact": "Wade Collins", "Email": "wade@cedarbendtrucks.example", "Phone": "(409) 555-0100", "Fax": "", "Autosoft Acct": "CEDB17",
      "Are you an Autosoft GO Dealer Y or N": "N", "Authorized Recipient Name": "DEALERADDENDUMS.COM / Casey Lane",
      "Authorized Recipient Phone": "801-415-9435 / FEEDS@DEALERADDENDUMS.COM", "Activate": "X", "undefined": "", "undefined_3": "",
      "Years of Historical DataDealer Addendum Vehicle Inventory": "", "Date_2": today, "Printed Name": "Wade Collins", "Title": "General Manager",
    };
    eq("Autosoft PDF: every mapped field holds its value", Object.fromEntries(Object.keys(want).map((k) => [k, val(k)])), want);
    eq("Autosoft PDF: unmapped fields untouched (Authorized Recipient #, Cancel boxes)", ["Authorized Recipient", "Cancel", "undefined_2", "undefined_4"].map(val), ["", "", "", ""]);
    const form = (await PDFDocument.load(pdf.bytes)).getForm();
    eq("Autosoft PDF: not flattened — signature field still there, 29 fields", [form.getFields().some((f) => f.getName() === "Customer Signature"), form.getFields().length], [true, 29]);
    eq("Autosoft PDF: fill report — only the intentionally blank fields are empty", pdf.report, { missingFields: [], emptyValues: ["Fax", "undefined", "undefined_3", "Years of Historical DataDealer Addendum Vehicle Inventory"] });
    const out = path.join(os.tmpdir(), "autosoft-data-transfer-filled.pdf");
    fs.writeFileSync(out, pdf.bytes);
    console.log(`     filled copy: ${out}`);
    if (process.argv.includes("--write-example")) {
      fs.writeFileSync(path.join(ROOT, "docs/feeds/suppliers/autosoft/data-transfer-form-filled-example.pdf"), pdf.bytes);
      console.log("     wrote docs/feeds/suppliers/autosoft/data-transfer-form-filled-example.pdf");
    }

    // Two dealerships, one form each, all on one email.
    const db2 = seedDb(asFx, as, { status: "ready" });
    ordRow(db2).email_thread_id = null;
    const prep2 = await prepareRequest(db2, ordRow(db2));
    const rows = [];
    for (const p of prep2.pdfs) { const v = await values(p.bytes); rows.push([p.dealershipName, v("Dealership Name"), v("Address"), v("Phone"), v("Autosoft Acct"), v("Activate"), v("Contact")]); }
    eq("Autosoft, two dealerships: one form per rooftop, each with its own name, address, phone and account",
      [prep2.problems, rows], [[], [["Cedar Bend Motors", "Cedar Bend Motors", "100 Fixture Way", "(409) 555-0100", "CEDB17", "X", "Wade Collins"], ["Cedar Bend Ford", "Cedar Bend Ford", "200 Fixture Way", "(409) 555-0101", "CEDB75", "X", "Wade Collins"]]]);
    sent = [];
    await sendRequest(db2, "ord", "staff-1");
    eq("Autosoft, two dealerships: ONE email with both forms; each form stored on its dealership",
      [sent.length, sent[0].attachments, sent[0].subject, ["ord-motors", "ord-ford"].map((id) => !!ordRow(db2, id).pdf_s3_key), ordRow(db2).pdf_s3_key ?? null],
      [1, ["Feed authorization FO-ORD - Cedar Bend Motors.pdf", "Feed authorization FO-ORD - Cedar Bend Ford.pdf"], "Inventory Feed Request for: Cedar Bend Motors and Cedar Bend Ford", [true, true], null]);
    eq("Autosoft, two dealerships: the email names both accounts", sent[0].body.includes("Autosoft account CEDB17/CEDB75"), true);

    // …or one combined form, when the dealer uses one account for both.
    const db3 = seedDb(asFx, as, { status: "ready", pdfMode: "combined" });
    const prep3 = await prepareRequest(db3, ordRow(db3));
    const v3 = await values(prep3.pdfs[0].bytes);
    eq("Autosoft, combined form: one PDF naming both dealerships and accounts, the group's address",
      [prep3.pdfs.length, prep3.pdfs[0].dealershipOrderId, v3("Dealership Name"), v3("Autosoft Acct"), v3("Address")], [1, null, "Cedar Bend Motors and Cedar Bend Ford", "CEDB17/CEDB75", "1 Group Plaza"]);
  }

  // ── Templates ───────────────────────────────────────────────────────────
  for (const p of SUPPLIER_PROFILES) {
    for (const [kind, t] of Object.entries(p.templates)) {
      eq(`${p.name} ${kind}: no unknown tokens, our subject convention`, [findUnknownTokens(t!.subject, t!.body_html), t!.subject.includes("Inventory Feed Request for: {{order.dealerships}}")], [[], true]);
    }
  }

  // ── Anonymization guard ─────────────────────────────────────────────────
  {
    const all = fs.readdirSync(FIX).filter((f) => f.endsWith(".json")).map((f) => fs.readFileSync(path.join(FIX, f), "utf8")).join("\n").toLowerCase();
    // Names, domains and IDs from the source threads (support@, Oct 2026) that must never be committed.
    const real = ["herzog", "trimble", "heath", "kestermann", "hmvw@", "beaverton", "landrovernc", "cape fear", "ryan king", "shaneh", "morell", "wilmington", "sour lake", "truckville", "rhodes", "angie", "marlena", "claire", "sour17", "sour75", "mp12601", "33486", "08192068", "08192333", "rvafjf", "hsb8uz", "500il0gsrlp"];
    eq("fixtures contain no real dealer / person / domain / ID from the source threads", real.filter((r) => all.includes(r)), []);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

/** The Autosoft group fixture's companies with no orders yet. */
function seedDbEmpty() {
  const fx = load("autosoft.json");
  const db = seedDb(fx, supplierProfile("Autosoft")!);
  db.rows("crm_feed_orders").splice(0);
  return db;
}

main().catch((e) => { console.error(e); process.exit(1); });
