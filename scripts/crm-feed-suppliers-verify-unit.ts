/* npm run test:crm-feed-suppliers — the three seeded feed suppliers (lib/crm/feeds/suppliers.ts)
   against their real, anonymized threads (scripts/fixtures/crm-feeds/*.json), no database or
   network: every inbound message goes through handleFeedsEmail() on the in-memory Supabase fake
   and must leave the order in the expected state with the expected Feed ID / case number / tasks
   / follow-up mail (mail + S3 are recorders via feedIo). Also: the supplier questions, the
   templates, the Autosoft PDF filled through the real request path (every mapped field checked),
   and a guard that no real dealer / person / ID from the source threads is in the fixtures.
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
import { feedIo, forwardSignedPdf, nudge, prepareRequest, sendRequest } from "../lib/crm/feeds/orders";
import { SUPPLIER_PROFILES, supplierProfile, type SupplierProfile } from "../lib/crm/feeds/suppliers";
import { htmlToText } from "../lib/crm/email-html";
import { classifyApproval, classifySupplierMessage, DEFAULT_APPROVAL_PHRASES, extractCaseNumber, extractFeedIds, findCancellationDeadline, latestReplyText } from "../lib/crm/feeds/detect";
import { checkSupplierFields, parseExtraFields, supplierFieldContext } from "../lib/crm/feeds/extra-fields";
import { pdfFieldNames } from "../lib/crm/feeds/pdf";
import { findUnknownTokens } from "../lib/crm/template-vars";
import { composeEmail } from "../lib/crm/email-compose";

let fail = 0, pass = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`}`);
}

const ROOT = path.resolve(__dirname, "..");
const FIX = path.join(__dirname, "fixtures", "crm-feeds");
const BLANK_PDF = path.join(ROOT, "docs/feeds/suppliers/autosoft/data-transfer-form-blank.pdf");
type Msg = { id: string; direction: "inbound" | "outbound"; thread: string; receivedAt: string; from: string; fromName: string | null; to: string[]; cc: string[]; subject: string; bodyHtml: string; attachments?: { filename: string; contentType: string; isInline?: boolean }[]; expect?: any; reconstructed?: boolean };
type Fixture = { supplier: string; dealer: { name: string; city: string; state: string; website: string }; approver: { name: string; email: string; title?: string }; supplier_fields: Record<string, string>; messages: Msg[]; supplierFollowupAfter?: string; forwardAfter?: string[]; sibling?: { name: string } };
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

// ── Fake DB for one fixture ──────────────────────────────────────────────────
function seedDb(fx: Fixture, profile: SupplierProfile, opts: { status?: string; extraOrders?: any[] } = {}) {
  const threads = Array.from(new Set(fx.messages.map((m) => m.thread)));
  const now = new Date().toISOString();
  const order = {
    id: "ord", dealer_company_id: "co-d", supplier_company_id: "sup", status: opts.status ?? "awaiting_dealer_approval",
    approver_name: fx.approver.name, approver_email: fx.approver.email, approver_title: fx.approver.title ?? null, approver_phone: null,
    email_thread_id: "T0", owner_staff_id: "staff-1", initiated_by_staff_id: "staff-1",
    supplier_fields: checkSupplierFields(profile.settings.extra_fields, fx.supplier_fields).values, metadata: {},
    sent_at: fx.messages[0].receivedAt, stall_timer_started_at: now, stalled_nudges: 0, created_at: now,
  };
  return (currentDb = fakeDb({
    crm_companies: [{ id: "co-d", kind: "dealer", website: fx.dealer.website, dealer_id: "dlr-1" }, { id: "sup", kind: "feed_supplier", name: profile.name }],
    crm_company_directory: [
      { id: "co-d", name: fx.dealer.name, dealer_text_id: "D-FIXTURE", city: fx.dealer.city, state: fx.dealer.state, phone: "+14095550100", dealer_id: "dlr-1" },
      { id: "sup", name: profile.name },
      ...(opts.extraOrders ?? []).map((o) => ({ id: o.dealer_company_id, name: o._name })),
    ],
    dealers: [{ id: "dlr-1", address: "100 Fixture Way", zip: "77659", inventory_provider: null, inventory_provider_is_dms: false }],
    profiles: [{ id: "staff-1", full_name: "Casey Lane", email: "casey@dealeraddendums.com" }],
    crm_staff_profiles: [{ staff_id: "staff-1", full_name: "Casey Lane" }],
    crm_feed_supplier_settings: [{ company_id: "sup", ...profile.settings, needs_review: false, pdf_template_s3_key: profile.pdfTemplate ? "crm/feed-suppliers/autosoft/blank.pdf" : null }],
    crm_feed_orders: [order, ...(opts.extraOrders ?? []).map(({ _name, ...o }) => o)],
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
    from_email: m.from, from_name: m.fromName, to: m.to.map((email) => ({ email, name: null })), cc: m.cc.map((email) => ({ email, name: null })),
    subject: m.subject, body_text: htmlToText(m.bodyHtml), body_html: m.bodyHtml, received_at: m.receivedAt, is_reply_all: true, has_attachments: !!m.attachments?.length,
  },
  thread: { id: m.thread, company_id: null, contact_id: null, subject: m.subject, status: "open", internal: false, message_count: 2 },
  mailbox: { id: "mb-feeds", address: "feeds@dealeraddendums.com", purpose: "feeds" },
});

async function runFixture(file: string) {
  const fx = load(file);
  const profile = supplierProfile(fx.supplier)!;
  const db = seedDb(fx, profile);
  sent = [];
  const order = () => db.rows("crm_feed_orders").find((o: any) => o.id === "ord");
  const openTasks = () => db.rows("crm_tasks").filter((t: any) => t.status === "open").map((t: any) => t.kind);
  console.log(`\n── ${fx.supplier} (${file}) ──`);
  for (const m of fx.messages) {
    if (m.direction === "inbound" && m.expect) {
      const x = m.expect;
      const label = `${fx.supplier} ${m.id} (${m.from.split("@")[0]}@…)`;
      const r = await handleFeedsEmail(event(m), db);
      const o = order();
      eq(`${label}: result / status`, [r, o.status], [x.result, x.status]);
      if (x.feedId) eq(`${label}: Feed ID candidate`, o.feed_id_candidate, x.feedId);
      if (x.caseNumber) eq(`${label}: case number on the order`, o.metadata?.case_number, x.caseNumber);
      if (x.openTasks) eq(`${label}: open tasks`, openTasks().sort(), [...x.openTasks].sort());
      if (x.mailsSent != null) eq(`${label}: mail sent so far`, sent.length, x.mailsSent);
      if (x.lastMail) {
        const last = sent[sent.length - 1];
        eq(`${label}: follow-up = reply all on the supplier's own message, to the approver`, [last?.mode, last?.emailId, last?.to], [x.lastMail.mode, x.lastMail.replyToMessage, x.lastMail.to]);
        eq(`${label}: follow-up wording`, last?.body.includes(x.lastMail.bodyIncludes), true);
      }
      if (x.cancellationIncludes) eq(`${label}: cancellation deadline captured`, String(o.metadata?.cancellation_deadline?.text ?? "").includes(x.cancellationIncludes), true);
      if (x.latestStartsWith) eq(`${label}: newest text after cleaning`, latestReplyText(htmlToText(m.bodyHtml)).startsWith(x.latestStartsWith), true);
      if (x.signedPdf) eq(`${label}: signed PDF on the order + company files`, [String(o.signed_pdf_s3_key).endsWith(x.signedPdf), db.rows("crm_company_files").some((f: any) => f.filename === x.signedPdf)], [true, true]);
      if (x.enterTaskIncludes) eq(`${label}: Enter Feed ID task names the account`, String(db.rows("crm_tasks").find((t: any) => t.kind === "feed_enter_feed_id")?.description ?? "").includes(x.enterTaskIncludes), true);
    }
    if (m.id === fx.supplierFollowupAfter) {
      await nudge(db, "ord", "supplier", "staff-1", true);
      const s = sent[sent.length - 1];
      eq(`${fx.supplier}: supplier follow-up is a NEW email to the supplier only, quoting the case`, [s.mode, s.to, s.cc, s.subject.includes(`case# ${order().metadata.case_number}`)], ["new", [profile.settings.request_email], [], true]);
    }
    if (fx.forwardAfter?.includes(m.id)) {
      await forwardSignedPdf(db, "ord", "staff-1");
      const s = sent[sent.length - 1];
      eq(`${fx.supplier}: Forward to supplier → new email to ${profile.settings.request_email} with the signed PDF`, [s.mode, s.to, s.attachments.length, s.subject], ["new", [profile.settings.request_email], 1, `Activation Rqst - Dealer Addendums - Inventory Feed Request for: ${fx.dealer.name}`]);
      eq(`${fx.supplier}: forwarding closes the forward task`, openTasks().includes("feed_forward_signed_pdf"), false);
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
  eq("vAuto case number: reply body and notice subject", [extractCaseNumber(null, "case# 08274519 has been created", va.settings.case_number_pattern), extractCaseNumber("Your vAuto support case #08274519 has been opened", "", va.settings.case_number_pattern)], ["08274519", "08274519"]);
  eq("Team Velocity case notice subject", extractCaseNumber("Team Velocity Case Case - 00412233 Created: Inventory Feed Request for: X", "", tv.settings.case_number_pattern), "00412233");
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

  // ── The three threads end-to-end ────────────────────────────────────────
  await runFixture("team-velocity.json");
  await runFixture("vauto.json");
  const { fx: asFx } = await runFixture("autosoft.json");

  // Autosoft answered two stores in one message: with both orders open, a person links it.
  {
    const db = seedDb(asFx, as, { status: "awaiting_supplier", extraOrders: [{ id: "ord-ford", dealer_company_id: "co-ford", supplier_company_id: "sup", status: "awaiting_supplier", approver_email: asFx.approver.email, email_thread_id: "T9", metadata: {}, supplier_fields: {}, _name: "Cedar Bend Ford" }] });
    eq("Autosoft: one reply naming both open orders → Unmatched (never guessed)", await handleFeedsEmail(event(asFx.messages.find((m) => m.id === "as-2")!), db), "unmatched");
  }

  // ── Sending ─────────────────────────────────────────────────────────────
  {
    const fx = load("vauto.json");
    const db = seedDb(fx, va, { status: "ready" });
    db.rows("crm_feed_orders")[0].email_thread_id = null;
    sent = [];
    await sendRequest(db, "ord", "staff-1");
    const s = sent[0];
    eq("vAuto request: a NEW thread, approver + vat.support, our standard subject, 'I approve' instruction",
      [s.mode, s.to, s.cc, s.subject, s.body.includes("<strong>I approve</strong>")], ["new", [fx.approver.email], ["vat.support@coxautoinc.com"], "Inventory Feed Request for: Harbor Point Land Rover", true]);
    eq("vAuto request: the order now waits on the dealer, on the request's own new thread", [db.rows("crm_feed_orders")[0].status, String(db.rows("crm_feed_orders")[0].email_thread_id).startsWith("T-sent-")], ["awaiting_dealer_approval", true]);
  }
  {
    const fx = load("team-velocity.json");
    const db = seedDb(fx, tv, { status: "ready" });
    sent = [];
    await sendRequest(db, "ord", "staff-1");
    eq("Team Velocity request: two addressed sections (supplier, then the approver's Reply All)",
      [sent[0].body.indexOf("<strong>Team Velocity Support:</strong>") > 0, sent[0].body.indexOf("<strong>Dan:</strong>") > sent[0].body.indexOf("Team Velocity Support:"), sent[0].body.includes("<strong>Reply All</strong>")], [true, true, true]);
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
    const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as any)[k])])) : v;
    eq("Autosoft questions survive the jsonb round trip (parseExtraFields keeps all four, Y/N options included)", canon(parseExtraFields(JSON.parse(JSON.stringify(defs)))), canon(defs));
    eq("choice → per-option X variables", supplierFieldContext(defs, { autosoft_account: "CEDB17", go_dealer: "N", transfer_row: "asis_vehinv2" })["order.supplier_fields.transfer_row.asis_vehinv2"], "X");

    const blankFields = await pdfFieldNames(fs.readFileSync(BLANK_PDF));
    eq("Autosoft field map: every mapped field exists in the blank form", Object.keys(as.settings.pdf_field_map).filter((f) => !blankFields.includes(f)), []);

    const fx = load("autosoft.json");
    const db = seedDb(fx, as, { status: "ready" });
    const prep = await prepareRequest(db, db.rows("crm_feed_orders")[0]);
    eq("Autosoft request: PDF method, request_pdf template, approver only (no Cc to Autosoft), no problems", [prep.method, prep.kind, prep.to.map((t) => t.email), prep.cc, prep.problems], ["pdf", "request_pdf", [fx.approver.email], [], []]);
    const form = (await PDFDocument.load(prep.pdf!.bytes)).getForm();
    const val = (n: string) => (form.getField(n) as PDFTextField).getText() ?? "";
    const today = new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "2-digit", day: "2-digit", year: "numeric" });
    const want: Record<string, string> = {
      "Dealership Name": "Cedar Bend Motors", "Date": today, "Address": "100 Fixture Way", "City": "Cedar Bend", "State": "TX", "Zip": "77659",
      "Contact": "Wade Collins", "Email": "wade@cedarbendtrucks.example", "Phone": "(409) 555-0100", "Fax": "", "Autosoft Acct": "CEDB17",
      "Are you an Autosoft GO Dealer Y or N": "N", "Authorized Recipient Name": "DEALERADDENDUMS.COM / Casey Lane",
      "Authorized Recipient Phone": "801-415-9435 / FEEDS@DEALERADDENDUMS.COM", "Activate": "X", "undefined": "", "undefined_3": "",
      "Years of Historical DataDealer Addendum Vehicle Inventory": "", "Date_2": today, "Printed Name": "Wade Collins", "Title": "General Manager",
    };
    eq("Autosoft PDF: every mapped field holds its value", Object.fromEntries(Object.keys(want).map((k) => [k, val(k)])), want);
    eq("Autosoft PDF: unmapped fields untouched (Authorized Recipient #, Cancel boxes)", ["Authorized Recipient", "Cancel", "undefined_2", "undefined_4"].map(val), ["", "", "", ""]);
    eq("Autosoft PDF: not flattened — signature field still there, 29 fields", [form.getFields().some((f) => f.getName() === "Customer Signature"), form.getFields().length], [true, 29]);
    eq("Autosoft PDF: fill report — only the intentionally blank fields are empty", prep.pdf!.report, { missingFields: [], emptyValues: ["Fax", "undefined", "undefined_3", "Years of Historical DataDealer Addendum Vehicle Inventory"] });
    const out = path.join(os.tmpdir(), "autosoft-data-transfer-filled.pdf");
    fs.writeFileSync(out, prep.pdf!.bytes);
    console.log(`     filled copy: ${out}`);
    if (process.argv.includes("--write-example")) {
      fs.writeFileSync(path.join(ROOT, "docs/feeds/suppliers/autosoft/data-transfer-form-filled-example.pdf"), prep.pdf!.bytes);
      console.log("     wrote docs/feeds/suppliers/autosoft/data-transfer-form-filled-example.pdf");
    }
  }

  // ── Templates ───────────────────────────────────────────────────────────
  for (const p of SUPPLIER_PROFILES) {
    for (const [kind, t] of Object.entries(p.templates)) {
      eq(`${p.name} ${kind}: no unknown tokens, our subject convention`, [findUnknownTokens(t!.subject, t!.body_html), t!.subject.includes("Inventory Feed Request for: {{company.name}}")], [[], true]);
    }
  }

  // ── Anonymization guard ─────────────────────────────────────────────────
  {
    const all = fs.readdirSync(FIX).filter((f) => f.endsWith(".json")).map((f) => fs.readFileSync(path.join(FIX, f), "utf8")).join("\n").toLowerCase();
    // Names, domains and IDs from the source threads (support@, Oct 2026) that must never be committed.
    const real = ["herzog", "trimble", "heath", "kestermann", "hmvw@", "beaverton", "landrovernc", "cape fear", "ryan king", "shaneh", "morell", "wilmington", "sour lake", "truckville", "rhodes", "angie", "marlena", "claire", "sour17", "sour75", "mp12601", "33486", "08192068", "08192333", "rvafjf", "hsb8uz"];
    eq("fixtures contain no real dealer / person / domain / ID from the source threads", real.filter((r) => all.includes(r)), []);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
