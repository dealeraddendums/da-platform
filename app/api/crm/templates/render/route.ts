import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { composeEmail } from "@/lib/crm/email-compose";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * POST /api/crm/templates/render — fill a template for a company / contact as
 * the signed-in staff member, exactly as it would be sent (Outlook-safe HTML,
 * signature appended). Body: { template_id } or { subject, body_html } (an
 * unsaved draft), plus company_id?, contact_id?, signature? (default true).
 * Used by the template picker (preview now; Phase 2 compose inserts the result).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  const b = await req.json().catch(() => ({}));
  const admin = createAdminSupabaseClient() as any;
  let subject: string, bodyHtml: string;
  if (typeof b?.template_id === "string") {
    const { data: t } = await admin.from("crm_email_templates").select("subject, body_html").eq("id", b.template_id).maybeSingle();
    if (!t) return NextResponse.json({ error: "Template not found" }, { status: 404 });
    ({ subject, body_html: bodyHtml } = t);
  } else if (typeof b?.body_html === "string") {
    subject = typeof b.subject === "string" ? b.subject : "";
    bodyHtml = b.body_html.slice(0, 200_000);
  } else return NextResponse.json({ error: "template_id or body_html required" }, { status: 400 });

  const out = await composeEmail({
    subject, bodyHtml,
    companyId: typeof b.company_id === "string" ? b.company_id : null,
    contactId: typeof b.contact_id === "string" ? b.contact_id : null,
    staffId: claims.sub,
    signature: b.signature !== false,
  }, admin);
  return NextResponse.json(out);
}
