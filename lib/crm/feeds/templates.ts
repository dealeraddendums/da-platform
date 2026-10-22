// Feed-request templates: Communications → Templates → "Feed requests".
// Kinds: request, request_pdf, dealer_followup, supplier_followup,
// supplier_forward (the signed PDF → supplier), feed_assigned. A global default per kind (supplier_company_id null) and
// optional per-supplier overrides; resolution is supplier override → global
// default → the built-in text below (so a fresh install still sends).
// The built-in wording is the team's own "Inventory Feed Request for: …"
// email (support@ Sent Items, 2026), with the explicit Reply All + APPROVED
// instruction the detection relies on. {{order.dealerships}} / {{order.dealership_list}}
// name every dealership on the request (one dealership = its name / location).
/* eslint-disable @typescript-eslint/no-explicit-any */

export const FEED_KINDS = ["request", "request_pdf", "dealer_followup", "supplier_followup", "supplier_forward", "feed_assigned"] as const;
export type FeedKind = (typeof FEED_KINDS)[number];
export const FEED_KIND_LABEL: Record<FeedKind, string> = {
  request: "Request (email)", request_pdf: "Request with PDF", dealer_followup: "Dealer follow-up",
  supplier_followup: "Supplier follow-up", supplier_forward: "Signed PDF to supplier", feed_assigned: "Feed assigned (to dealer)",
};
export const FEED_CATEGORY = "Feed requests";
export const supplierFolder = (supplierName: string) => `${FEED_CATEGORY} · ${supplierName}`;

/** Every request body must end with this instruction (dealer_approved detection looks for the reply to it). */
export const APPROVAL_INSTRUCTION = "Please Reply All to this email and write APPROVED to approve this inventory feed request.";

export const DEFAULT_FEED_TEMPLATES: Record<FeedKind, { name: string; subject: string; body_html: string }> = {
  request: {
    name: "Feed request — email",
    subject: "Inventory Feed Request for: {{order.dealerships}}",
    body_html: `<p>Hello {{supplier.name}} Support and {{approver.first_name | "there"}},</p>
<p>We're requesting an inventory feed for:</p>
<p>{{order.dealership_list}}</p>
<p><strong>{{supplier.name}} Support:</strong> please add {{order.dealerships}} to the Dealer Addendums inventory feed file and reply with the unique Dealer ID for each store once completed.</p>
<p><strong>{{approver.first_name | "Approver"}}:</strong> ${APPROVAL_INSTRUCTION}</p>
<p>Once we have your approval and the Dealer ID from {{supplier.name}}, we can complete the setup on our end. Please let us know if you have any questions. Thank you!</p>`,
  },
  request_pdf: {
    name: "Feed request — PDF authorization",
    subject: "Inventory Feed Authorization for: {{order.dealerships}}",
    body_html: `<p>Hello {{approver.first_name | "there"}},</p>
<p>{{supplier.name}} needs a signed authorization before it can send {{order.dealerships}}'s inventory to Dealer Addendums. The form is attached, filled in with your dealership's details.</p>
<p>Please sign it, attach the signed copy, and Reply All to this email (we've copied {{supplier.name}}). Writing APPROVED in your reply is perfect.</p>
<p>Once {{supplier.name}} has the signed form and sends us the Dealer ID, we'll finish the setup. Thank you!</p>`,
  },
  dealer_followup: {
    name: "Feed request — dealer follow-up",
    subject: "RE: Inventory Feed Request for: {{order.dealerships}}",
    body_html: `<p>Hi {{approver.first_name | "there"}},</p>
<p>Just following up on the inventory feed request for {{order.dealerships}} we sent on {{order.sent_on}}. We can't start the feed until we hear from you.</p>
<p>${APPROVAL_INSTRUCTION}</p>
<p>Thank you!</p>`,
  },
  supplier_followup: {
    name: "Feed request — supplier follow-up",
    subject: "RE: Inventory Feed Request for: {{order.dealerships}}",
    body_html: `<p>Hello {{supplier.name}} Support,</p>
<p>Following up on the inventory feed request for {{order.dealerships}}, sent {{order.sent_on}}. The dealership has approved it.</p>
<p>Could you let us know the Dealer ID for the Dealer Addendums feed, or whether you need anything else from us?</p>
<p>Thank you!</p>`,
  },
  supplier_forward: {
    name: "Signed authorization — to supplier",
    subject: "Signed inventory feed authorization: {{order.dealerships}}",
    body_html: `<p>Hello {{supplier.name}} Support,</p>
<p>Attached is the signed inventory feed authorization for {{order.dealerships}}. Please send us the Dealer ID once the feed is set up.</p>
<p>Thank you!</p>`,
  },
  feed_assigned: {
    name: "Feed assigned — to dealer",
    subject: "Your inventory feed is set up — {{order.dealerships}}",
    body_html: `<p>Hi {{approver.first_name | "there"}},</p>
<p>Good news: {{supplier.name}} has set up {{order.dealerships}}'s inventory feed to DealerAddendums (feed ID {{order.feed_id}}). Your vehicles will start appearing in your DealerAddendums account with the next inventory update, usually within a day.</p>
<p>If anything looks off once they arrive, just reply to this email. Thank you!</p>`,
  },
};

export type ResolvedTemplate = { id: string | null; name: string; subject: string; body_html: string; source: "supplier" | "global" | "built_in" };

/** Supplier override → global default → built-in text. */
export async function resolveFeedTemplate(admin: any, kind: FeedKind, supplierCompanyId: string | null): Promise<ResolvedTemplate> {
  const { data } = await admin.from("crm_email_templates").select("id, name, subject, body_html, supplier_company_id")
    .eq("feed_kind", kind).eq("archived", false);
  const rows: any[] = data ?? [];
  const own = supplierCompanyId ? rows.find((r) => r.supplier_company_id === supplierCompanyId) : null;
  if (own) return { id: own.id, name: own.name, subject: own.subject, body_html: own.body_html, source: "supplier" };
  const global = rows.find((r) => !r.supplier_company_id);
  if (global) return { id: global.id, name: global.name, subject: global.subject, body_html: global.body_html, source: "global" };
  return { id: null, ...DEFAULT_FEED_TEMPLATES[kind], source: "built_in" };
}

/** "FO-1A2B3C" — the short order number staff read out on the phone. */
export const orderNumber = (id: string) => `FO-${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
