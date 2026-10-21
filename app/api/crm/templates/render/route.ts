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
  let subject: string, bodyHtml: string, feedKind: string | null = typeof b?.feed_kind === "string" ? b.feed_kind : null;
  let supplierId: string | null = typeof b?.supplier_company_id === "string" ? b.supplier_company_id : null;
  if (typeof b?.template_id === "string") {
    const { data: t } = await admin.from("crm_email_templates").select("subject, body_html, feed_kind, supplier_company_id").eq("id", b.template_id).maybeSingle();
    if (!t) return NextResponse.json({ error: "Template not found" }, { status: 404 });
    ({ subject, body_html: bodyHtml } = t);
    feedKind = t.feed_kind ?? feedKind;
    supplierId = t.supplier_company_id ?? supplierId;
  } else if (typeof b?.body_html === "string") {
    subject = typeof b.subject === "string" ? b.subject : "";
    bodyHtml = b.body_html.slice(0, 200_000);
  } else return NextResponse.json({ error: "template_id or body_html required" }, { status: 400 });

  // Feed templates preview "as sent" with a real order (feed_order_id) or a sample one.
  let extraContext: Record<string, string | null> | undefined;
  if (typeof b?.feed_order_id === "string") {
    const { loadOrder, orderTemplateContext } = await import("@/lib/crm/feeds/orders");
    extraContext = (await orderTemplateContext(admin, await loadOrder(admin, b.feed_order_id).catch(() => null) ?? {})) as any;
  } else if (feedKind) {
    const { data: sup } = supplierId ? await admin.from("crm_company_directory").select("name").eq("id", supplierId).maybeSingle() : { data: null };
    const { data: st } = supplierId ? await admin.from("crm_feed_supplier_settings").select("request_email").eq("company_id", supplierId).maybeSingle() : { data: null };
    extraContext = {
      "supplier.name": sup?.name ?? "vAuto", "supplier.request_email": st?.request_email ?? "vat.support@coxautoinc.com",
      "approver.name": "Sample Approver", "approver.first_name": "Sample", "approver.email": "approver@example.com", "dealer.dms": null,
      "order.id": "FO-SAMPLE", "order.sent_on": new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }), "order.feed_id": "MP12345",
    };
  }
  const out = await composeEmail({
    subject, bodyHtml,
    companyId: typeof b.company_id === "string" ? b.company_id : null,
    contactId: typeof b.contact_id === "string" ? b.contact_id : null,
    staffId: claims.sub,
    signature: b.signature !== false,
    extraContext,
  }, admin);
  return NextResponse.json(out);
}
