// The feed suppliers we have real threads for (support@, Oct 2026) — their
// settings and per-supplier "Feed requests" templates, as data. Seeded by
// scripts/crm-feeds-seed.ts (authoritative for these four: re-running the
// seed resets them to what's here) and exercised end-to-end against the
// anonymized threads in scripts/fixtures/crm-feeds/ (test:crm-feed-suppliers).
//
// Conventions every supplier shares (lib/crm/feeds/detect.ts, inbound.ts):
//   • our subject is always "Inventory Feed Request for: {{order.dealerships}}" (the dealership's
//     name; "A and B" for one request covering several of a group's rooftops)
//   • suppliers reply on that thread AND start their own (Team Velocity's "DEALER APPROVAL
//     REQUIRED RE: …", vAuto's "[ thread::…:: ]" case thread) — matched by thread first, then by
//     the dealer's name from the supplier's or the dealer's domain
//   • whoever approves at the dealership counts, not only the person we addressed
//   • a supplier's cancellation deadline ("by end of day today", "within 3 Business days")
//     triggers an immediate dealer follow-up + owner task, without waiting for the day-2 timer

import type { ExtraField } from "./extra-fields";
import type { FeedKind } from "./templates";
import type { RequestMethod } from "./state";

export type SupplierProfile = {
  /** crm_companies.name — must match lib/inventory-providers.ts (it's written to the dealer record). */
  name: string;
  settings: {
    request_method: RequestMethod; request_email: string; cc_emails: string[]; domains: string[];
    feed_id_pattern: string | null; feed_id_manual: boolean; case_number_pattern: string | null;
    approval_phrases: string[]; cancellation_patterns: string[]; followup_new_thread: boolean;
    typical_turnaround_days: number; platform_provider: string; is_dms: boolean;
    pdf_field_map: Record<string, string>; extra_fields: ExtraField[]; notes: string;
  };
  /** Repo path of the blank PDF the seed uploads as pdf_template_s3_key. */
  pdfTemplate?: string;
  templates: Partial<Record<FeedKind, { name: string; subject: string; body_html: string }>>;
};

// {{order.dealerships}} = the dealership's name, or "A and B" when one request covers several
// (Autosoft's real reply: "Inventory Feed Request for: Sour Lake Motors and Sour Lake Ford").
const SUBJECT = "Inventory Feed Request for: {{order.dealerships}}";

// ── Team Velocity ────────────────────────────────────────────────────────────
const TEAM_VELOCITY: SupplierProfile = {
  name: "Team Velocity",
  settings: {
    request_method: "email", request_email: "support@teamvelocitymarketing.com", cc_emails: [],
    domains: ["teamvelocitymarketing.com"],
    // "Filename: 33486.csv" → 33486
    feed_id_pattern: "Filename:\\s*(\\d+)\\.csv", feed_id_manual: false,
    // "Team Velocity Case Case - 00399027 Created: …"
    case_number_pattern: "\\bCase\\s*-\\s*(\\d{5,})",
    approval_phrases: [],
    cancellation_patterns: ["if we do not receive approval by [^.]+, we will cancel this request"],
    followup_new_thread: false, typical_turnaround_days: 2, platform_provider: "Team Velocity", is_dms: false,
    pdf_field_map: {}, extra_fields: [],
    notes: "Replies come from support@ (display name \"Support Integration\") through Salesforce, with a per-dealer CC alias (e.g. hmvw@teamvelocitymarketing.com) and case notices from salesforce.teamvelocitymarketing.com. Team Velocity runs its OWN approval email to the dealer (\"DEALER APPROVAL REQUIRED RE: …\", Reply All with APPROVED) and cancels the request \"by end of day today\" without it. The Feed ID arrives as a filename: \"Filename: 33486.csv\" → 33486.",
  },
  templates: {
    request: {
      name: "Team Velocity — feed request",
      subject: SUBJECT,
      body_html: `<p>Hello Team Velocity Support and {{approver.first_name | "there"}},</p>
<p>We’re requesting an inventory feed for:</p>
<p>{{order.dealership_list}}</p>
<p><strong>Team Velocity Support:</strong><br>Please add {{order.dealerships}} to the Dealer Addendums inventory feed file and provide the <strong>unique Dealer ID</strong> for each store once completed.</p>
<p><strong>{{approver.first_name | "Approver"}}:</strong><br>Please <strong>Reply All</strong> to this email and write <strong>APPROVED</strong> to confirm you approve this inventory feed request. Team Velocity will usually email you for the same approval — please Reply All APPROVED to theirs too, or they cancel the request.</p>
<p>Once we have your approval and the Dealer ID from Team Velocity, we can complete the setup on our end.</p>
<p>Please let us know if you have any questions. Thank you!</p>`,
    },
    dealer_followup: {
      name: "Team Velocity — dealer follow-up",
      subject: `RE: ${SUBJECT}`,
      body_html: `<p>Hi {{approver.first_name | "there"}},</p>
<p>Team Velocity is waiting on your approval to send {{order.dealerships}}’s inventory to Dealer Addendums, and cancels the request if they don’t hear from you.</p>
<p>Please <strong>Reply All</strong> to this email and write <strong>APPROVED</strong> — Team Velocity is copied, so that’s all they need.</p>
<p>Thank you!</p>`,
    },
    supplier_followup: {
      name: "Team Velocity — supplier follow-up",
      subject: `RE: ${SUBJECT}`,
      body_html: `<p>Hello Team Velocity Support,</p>
<p>Following up on the inventory feed request for {{order.dealerships}}, sent {{order.sent_on}}. The dealership has approved it.</p>
<p>Could you send us the feed filename / Dealer ID once the file is set up?</p>
<p>Thank you!</p>`,
    },
  },
};

// ── vAuto (Cox Automotive) ───────────────────────────────────────────────────
const VAUTO: SupplierProfile = {
  name: "Vauto",
  settings: {
    request_method: "email", request_email: "vat.support@coxautoinc.com", cc_emails: [],
    domains: ["coxautoinc.com"],
    // "The export for {dealer} is enabled, ID: MP12601."
    feed_id_pattern: "ID:\\s*([A-Z]{2}\\d+)", feed_id_manual: false,
    // "case# 08192068 has been created" (reply) · "Your vAuto support case #08192068 has been opened" (notice)
    case_number_pattern: "case\\s*#\\s*(\\d+)",
    approval_phrases: ["I approve"],
    cancellation_patterns: ["if approval is not received within 3 business days, this case will be closed"],
    followup_new_thread: true, typical_turnaround_days: 3, platform_provider: "Vauto", is_dms: false,
    pdf_field_map: {}, extra_fields: [],
    notes: "vAuto Support (display \"vAuto Support\") opens a case per request (\"case# 08192068 has been created\") and closes it on completion; a reply on a closed case is ignored (\"additional requests… send a new email\"). So every order starts a NEW thread and the Supplier follow-up is a fresh email quoting the case number. The dealer must reply exactly \"I approve\"; the case closes \"if approval is not received within 3 Business days\". Feed IDs: \"ID: MP12601\".",
  },
  templates: {
    request: {
      name: "vAuto — feed request",
      subject: SUBJECT,
      body_html: `<p>Hello vAuto Support and {{approver.first_name | "there"}},</p>
<p>We’re requesting an inventory feed for:</p>
<p>{{order.dealership_list}}</p>
<p><strong>vAuto Support:</strong><br>Please add {{order.dealerships}} to the Dealer Addendums inventory feed file and provide the <strong>unique Dealer ID</strong> for each store once completed.</p>
<p><strong>{{approver.first_name | "Approver"}}:</strong><br>Please <strong>Reply All</strong> to this email with the words <strong>I approve</strong>. vAuto needs that exact wording from the dealership before it can enable the feed, and closes the request if approval doesn’t arrive within 3 business days.</p>
<p>Once we have your approval and the Dealer ID from vAuto, we can complete the setup on our end.</p>
<p>Please let us know if you have any questions. Thank you!</p>`,
    },
    dealer_followup: {
      name: "vAuto — dealer follow-up",
      subject: `RE: ${SUBJECT}`,
      body_html: `<p>Hi {{approver.first_name | "there"}},</p>
<p>vAuto is waiting on your approval to send {{order.dealerships}}’s inventory to Dealer Addendums (case {{order.case_number | "pending"}}), and closes the case if approval isn’t received within 3 business days.</p>
<p>Please <strong>Reply All</strong> to this email with the words <strong>I approve</strong>.</p>
<p>Thank you!</p>`,
    },
    supplier_followup: {
      name: "vAuto — supplier follow-up (new email)",
      subject: `${SUBJECT} — case# {{order.case_number | "not received"}}`,
      body_html: `<p>Hello vAuto Support,</p>
<p>Following up on case# {{order.case_number | "(we didn’t receive a case number)"}}: the inventory feed request for {{order.dealerships}}, sent {{order.sent_on}}. The dealership has approved it (“I approve”).</p>
<p>Could you let us know the export ID once the feed is enabled?</p>
<p>Thank you!</p>`,
    },
  },
};

// ── Autosoft (DMS) ───────────────────────────────────────────────────────────
// Data Transfer Authorization, fillable field names as in docs/feeds/suppliers/autosoft/
// data-transfer-form-blank.pdf. The three transfer rows' Activate boxes are TEXT fields:
// "Activate" (ASIS_VehInv2), "undefined" (Vehicle Inv Detail F&I), "undefined_3" (GoBatch).
const AUTOSOFT: SupplierProfile = {
  name: "Autosoft",
  pdfTemplate: "docs/feeds/suppliers/autosoft/data-transfer-form-blank.pdf",
  settings: {
    request_method: "pdf", request_email: "dcsconnect@autosoftdms.com", cc_emails: [],
    domains: ["autosoftdms.com"],
    // "DealerAddendums has been activated for SOUR17/SOUR75" — one code per dealership, each its Autosoft account.
    feed_id_pattern: "activated for\\s*([A-Z0-9/]+)", feed_id_manual: false,
    // Salesforce's "[ ref:!00Df20Cce8.!500iL0GsRLP:ref ]" on every reply = Autosoft's case reference.
    case_number_pattern: "ref:(\\S+?):ref",
    approval_phrases: [], cancellation_patterns: [], followup_new_thread: false,
    typical_turnaround_days: 3, platform_provider: "Autosoft", is_dms: true,
    pdf_field_map: {
      "Dealership Name": "{{company.name}}",
      "Date": "{{today.short}}",
      "Address": "{{company.address}}",
      "City": "{{company.city}}",
      "State": "{{company.state}}",
      "Zip": "{{company.zip}}",
      "Contact": "{{approver.name}}",
      "Email": "{{approver.email}}",
      "Phone": "{{company.phone}}",
      "Fax": "{{company.fax}}",
      "Autosoft Acct": "{{order.supplier_fields.autosoft_account}}",
      "Are you an Autosoft GO Dealer Y or N": "{{order.supplier_fields.go_dealer}}",
      "Authorized Recipient Name": "DEALERADDENDUMS.COM / {{staff.full_name}}",
      "Authorized Recipient Phone": "801-415-9435 / FEEDS@DEALERADDENDUMS.COM",
      "Activate": "{{order.supplier_fields.transfer_row.asis_vehinv2}}",
      "undefined": "{{order.supplier_fields.transfer_row.vehicle_inv_detail_fi}}",
      "undefined_3": "{{order.supplier_fields.transfer_row.gobatch}}",
      "Years of Historical DataDealer Addendum Vehicle Inventory": "{{order.supplier_fields.historical_years}}",
      "Date_2": "{{today.short}}",
      "Printed Name": "{{approver.name}}",
      "Title": "{{approver.title}}",
    },
    extra_fields: [
      // Per dealership, and it IS the Feed ID: pre-fills each dealership's candidate; "activated for X/Y" is matched to it.
      { key: "autosoft_account", label: "Autosoft account number", type: "text", required: true, uppercase: true, pattern: "^[A-Z]{4}\\d{2}$", per_dealership: true, feed_id: true,
        help: "the dealer's Autosoft Customer ID — four letters and two digits, e.g. ABCD17; the dealer can give it to you" },
      { key: "go_dealer", label: "Autosoft GO dealer?", type: "choice", required: true, default: "N",
        options: [{ value: "N", label: "No" }, { value: "Y", label: "Yes" }] },
      { key: "transfer_row", label: "Transfer to activate", type: "choice", required: true, default: "asis_vehinv2",
        options: [
          { value: "asis_vehinv2", label: "ASIS_VehInv2 — Vehicle Inventory, Batch/FTP (what we normally ask for)" },
          { value: "vehicle_inv_detail_fi", label: "Vehicle Inv Detail F&I — Batch/FTP" },
          { value: "gobatch", label: "Dealer Addendum Vehicle Inventory — GoBatch (GO dealers only)",
            requires: { key: "go_dealer", value: "Y", message: "GoBatch is only for Autosoft GO dealers — Autosoft rejects the form otherwise. Pick ASIS_VehInv2." } },
        ] },
      { key: "historical_years", label: "Years of historical data", type: "text", pattern: "^\\d{1,2}$", help: "GoBatch only, a number of years",
        only_with: { key: "transfer_row", value: "gobatch" } },
    ],
    notes: "Autosoft needs its Data Transfer Authorization, signed by the dealer, for each dealership (\"The Autosoft Account Number must be included on the form\"). We pre-fill it, email it to the approver, the dealer returns it signed to feeds@, and staff Forward it to dcsconnect@autosoftdms.com. Autosoft replies through Salesforce (noreply@salesforce.com on behalf of dcsconnect@) with a \"[ ref:…:ref ]\" token in the subject (kept as the case reference): \"DealerAddendums has been activated for SOUR17/SOUR75\" — the Feed ID IS the Autosoft account, one per dealership, so each code is matched to the dealership with that account. Autosoft rejected a form that ticked the GoBatch row for a non-GO dealer (2026-10-21): the default row is ASIS_VehInv2.",
  },
  templates: {
    request_pdf: {
      name: "Autosoft — authorization form",
      subject: SUBJECT,
      body_html: `<p>Hello {{approver.first_name | "there"}},</p>
<p>Autosoft needs a signed <strong>Data Transfer Authorization</strong> before it can send {{order.dealerships}}’s inventory to Dealer Addendums. The form is attached, already filled in with the dealership details and Autosoft account {{order.supplier_fields.autosoft_account}}.</p>
<p>Please check the details, <strong>sign and date</strong> it at the bottom, and <strong>Reply All</strong> to this email with the signed form attached. We’ll forward it to Autosoft for activation — you don’t need to send it to them yourself.</p>
<p>Please let us know if you have any questions. Thank you!</p>`,
    },
    dealer_followup: {
      name: "Autosoft — dealer follow-up",
      subject: `RE: ${SUBJECT}`,
      body_html: `<p>Hi {{approver.first_name | "there"}},</p>
<p>We still need the signed Autosoft Data Transfer Authorization for {{order.dealerships}} — it was attached to our email on {{order.sent_on}}.</p>
<p>Please sign and date it, then <strong>Reply All</strong> with the signed copy attached and we’ll send it on to Autosoft.</p>
<p>Thank you!</p>`,
    },
    supplier_forward: {
      name: "Autosoft — activation request (signed form)",
      subject: `Activation Rqst - Dealer Addendums - ${SUBJECT}`,
      body_html: `<p>Hello Autosoft DCS Connect,</p>
<p>Attached is the signed Data Transfer Authorization for {{order.dealerships}} (Autosoft account {{order.supplier_fields.autosoft_account}}). Please activate the Dealer Addendums inventory feed.</p>
<p>Thank you!</p>`,
    },
    supplier_followup: {
      name: "Autosoft — supplier follow-up",
      subject: `RE: Activation Rqst - Dealer Addendums - ${SUBJECT}`,
      body_html: `<p>Hello Autosoft DCS Connect,</p>
<p>Following up on the signed Data Transfer Authorization for {{order.dealerships}} (Autosoft account {{order.supplier_fields.autosoft_account}}). Could you let us know once Dealer Addendums is activated?</p>
<p>Thank you!</p>`,
    },
  },
};

// ── VinCue ───────────────────────────────────────────────────────────────────
// Request = support@'s HubSpot "VinCue feed request" template as sent (the same wording every HubSpot
// feed request uses — e.g. vAuto's to Honda of Sarasota, 2026-10-22), minus the template's red
// instruction line, which never went out. Feed ID reply (support@dealercue.com, "… from VINCUE Support
// Services"): "I have added the {dealership} to your export under the ID of 46393." — the dealership
// is named in that sentence, which is how a reply off the order thread finds its order.
const VINCUE: SupplierProfile = {
  name: "Vincue",
  settings: {
    request_method: "email", request_email: "support@dealercue.com", cc_emails: [],
    // dealercue.com sends; vincue.com is their web / signature domain (onboarding@, project managers).
    domains: ["dealercue.com", "vincue.com"],
    // "under the ID of 46393" · "ID of 46393" · "ID: 46393" — one capture group for all three.
    feed_id_pattern: "\\bID(?:\\s+of|\\s*:)\\s*(\\d+)", feed_id_manual: false,
    case_number_pattern: null, approval_phrases: [], cancellation_patterns: [], followup_new_thread: false,
    // Same day to 2 days after the dealer approves.
    typical_turnaround_days: 2, platform_provider: "Vincue", is_dms: false,
    pdf_field_map: {}, extra_fields: [],
    notes: "VinCue Support (support@dealercue.com, display \"{name} from VINCUE Support Services\") adds the store to our export and replies \"I have added the {dealership} to your export under the ID of 46393.\" — same day to 2 days after approval. Their project managers (@dealercue.com / @vincue.com) also start feeds themselves: \"Inventory Source Change - Dealer Addendums // {group}\", listing each rooftop with its Feed ID and asking the dealer to Reply All approved (McSweeney Auto Group, Oct 2026) — those arrive in support@, not as orders.",
  },
  templates: {
    request: {
      name: "VinCue — feed request",
      subject: SUBJECT,
      body_html: `<p>Hello VinCue Support and {{approver.first_name | "there"}},</p>
<p>We’re requesting an inventory feed for:</p>
<p>{{order.dealership_list}}</p>
<p><strong>VinCue Support:</strong></p>
<p>Please add {{order.dealerships}} to the Dealer Addendums inventory feed file and provide the store’s unique Dealer ID once completed.</p>
<p><strong>{{approver.first_name | "Approver"}}:</strong></p>
<p>Please Reply All to this email confirming that you approve this inventory feed request.</p>
<p>Once we have your approval and the Dealer ID from VinCue, we can complete the setup on our end.</p>
<p>Please let us know if you have any questions. Thank you!</p>`,
    },
  },
};

export const SUPPLIER_PROFILES: SupplierProfile[] = [TEAM_VELOCITY, VAUTO, AUTOSOFT, VINCUE];
export const supplierProfile = (name: string) => SUPPLIER_PROFILES.find((p) => p.name.toLowerCase() === name.toLowerCase()) ?? null;
