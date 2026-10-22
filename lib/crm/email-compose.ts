// DA-CRM outbound email assembly — the ONE path every email takes (template
// preview now; Phase 2 Inbox compose / reply / send later):
//   1. fill {{variables}} from the company / contact / sending staff member
//   2. sanitize to Outlook-safe inline-styled HTML (lib/crm/email-html.ts)
//   3. append the sender's crm_staff_profiles.email_signature_html
// so no email can go out without the signature or with unsanitized markup.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createAdminSupabaseClient } from "@/lib/db";
import { renderTemplate, type TemplateContext } from "./template-vars";
import { toEmailHtml, wrapEmail, htmlToText } from "./email-html";
import { trialStatus } from "./trial";
import { formatPhone } from "./phone";

const firstName = (full: string | null | undefined) => (full ?? "").trim().split(/\s+/)[0] || null;
const longDate = (d: Date | string) =>
  new Date(typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00Z` : d)
    .toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "long", day: "numeric", year: "numeric" });
/** 10/21/2026 — what paper forms (the Autosoft authorization) expect. */
const shortDate = (d: Date) => d.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "2-digit", day: "2-digit", year: "numeric" });

/** Variable values for this company / contact / sender. Unknown ids → those groups stay empty. */
export async function buildTemplateContext(
  ids: { companyId?: string | null; contactId?: string | null; staffId: string },
  admin: any = createAdminSupabaseClient(),
  now = new Date(),
): Promise<TemplateContext> {
  const ctx: TemplateContext = { today: longDate(now), "today.short": shortDate(now) };

  let companyId = ids.companyId ?? null;
  if (ids.contactId) {
    const { data: c } = await admin.from("crm_contacts").select("company_id, first_name, last_name, email, phone, title")
      .eq("id", ids.contactId).is("deleted_at", null).maybeSingle();
    if (c) {
      companyId = companyId ?? c.company_id;
      Object.assign(ctx, {
        "contact.first_name": c.first_name, "contact.last_name": c.last_name,
        "contact.full_name": [c.first_name, c.last_name].filter(Boolean).join(" ") || null,
        "contact.email": c.email, "contact.phone": c.phone ? formatPhone(c.phone) : null, "contact.title": c.title,
      });
    }
  }

  if (companyId) {
    const [{ data: d }, { data: co }] = await Promise.all([
      admin.from("crm_company_directory").select("name, dealer_text_id, city, state, phone, owner_staff_id, pipeline_stage, trial_started_at, dealer_id, group_id").eq("id", companyId).maybeSingle(),
      admin.from("crm_companies").select("website").eq("id", companyId).maybeSingle(),
    ]);
    if (d) {
      const src = d.dealer_id
        ? (await admin.from("dealers").select("address, zip, trial_ends_at").eq("id", d.dealer_id).maybeSingle()).data
        : d.group_id ? (await admin.from("groups").select("address, zip").eq("id", d.group_id).maybeSingle()).data : null;
      Object.assign(ctx, {
        "company.name": d.name, "company.dealer_id": d.dealer_text_id, "company.city": d.city, "company.state": d.state,
        "company.address": src?.address ?? null, "company.zip": src?.zip ?? null,
        "company.phone": d.phone ? formatPhone(d.phone) : null, "company.website": co?.website ?? null,
      });
      if (d.pipeline_stage === "trial" && d.trial_started_at) {
        const s = trialStatus(d.trial_started_at, now, src?.trial_ends_at ?? null);
        Object.assign(ctx, { "trial.day": s.trialDay, "trial.days_left": Math.max(0, s.daysLeft + 1), "trial.ends_on": longDate(s.endsOn) });
      }
      if (d.owner_staff_id) {
        const owner = await staffIdentity(admin, d.owner_staff_id);
        Object.assign(ctx, { "owner.full_name": owner.fullName, "owner.first_name": firstName(owner.fullName) });
      }
    }
  }

  const me = await staffIdentity(admin, ids.staffId);
  Object.assign(ctx, {
    "staff.full_name": me.fullName, "staff.first_name": firstName(me.fullName),
    "staff.email": me.email, "staff.phone": me.phone ? formatPhone(me.phone) : null,
  });
  return ctx;
}

async function staffIdentity(admin: any, staffId: string): Promise<{ fullName: string | null; email: string | null; phone: string | null; signature: string | null }> {
  const [{ data: p }, { data: sp }] = await Promise.all([
    admin.from("profiles").select("full_name, email").eq("id", staffId).maybeSingle(),
    admin.from("crm_staff_profiles").select("full_name, dialpad_number, email_signature_html").eq("staff_id", staffId).maybeSingle(),
  ]);
  return {
    fullName: sp?.full_name || p?.full_name || null,
    email: p?.email ?? null,
    phone: sp?.dialpad_number ?? null,
    signature: sp?.email_signature_html ?? null,
  };
}

export type ComposedEmail = {
  subject: string;
  html: string;          // full Outlook-safe body, signature included
  text: string;          // plain-text alternative
  hasSignature: boolean;
  missing: string[];     // known variables with no value here (rendered empty)
  unknown: string[];     // tokens DA-CRM can't fill (left as typed)
};

/** Render + sanitize + sign. `signature: false` only for previews of the body alone. */
export async function composeEmail(
  input: {
    subject: string; bodyHtml: string; companyId?: string | null; contactId?: string | null; staffId: string; signature?: boolean;
    /** Extra variable values (feed orders: supplier.*, approver.*, order.*); they win over the defaults. */
    extraContext?: TemplateContext;
  },
  admin: any = createAdminSupabaseClient(),
): Promise<ComposedEmail> {
  const ctx = { ...(await buildTemplateContext(input, admin)), ...(input.extraContext ?? {}) };
  const subject = renderTemplate(input.subject ?? "", ctx, { html: false });
  const body = renderTemplate(input.bodyHtml ?? "", ctx, { html: true });
  const sigRaw = input.signature === false ? null : (await staffIdentity(admin, input.staffId)).signature;
  const sig = sigRaw ? toEmailHtml(sigRaw) : null;
  const html = wrapEmail(toEmailHtml(body.text), sig);
  return {
    subject: subject.text.replace(/\s+/g, " ").trim(),
    html,
    text: htmlToText(html),
    hasSignature: !!sig,
    missing: Array.from(new Set([...subject.missing, ...body.missing])),
    unknown: Array.from(new Set([...subject.unknown, ...body.unknown])),
  };
}
