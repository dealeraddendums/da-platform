import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { composeEmail, buildTemplateContext } from "@/lib/crm/email-compose";
import { supplierFieldContext } from "@/lib/crm/feeds/extra-fields";
import { supplierSettings } from "@/lib/crm/feeds/orders";
import { resolveFeedTemplate, FEED_KINDS, type FeedKind } from "@/lib/crm/feeds/templates";
import { fillRequestPdf, samplePdfTemplate, SAMPLE_PDF_FIELD_MAP } from "@/lib/crm/feeds/pdf";
import { UUID } from "@/lib/crm/feeds/http";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * POST /api/crm/feeds/suppliers/[id]/test-render { dealer_company_id, kind? } —
 * this supplier's template (override → global → built-in) rendered for a
 * sample dealer with a sample approver / order, plus the filled PDF (or the
 * built-in sample form when no template is uploaded).
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  const b = await req.json().catch(() => ({}));
  if (!UUID.test(params.id) || !UUID.test(b?.dealer_company_id ?? "")) return NextResponse.json({ error: "dealer_company_id required" }, { status: 400 });
  const admin = createAdminSupabaseClient() as any;
  const settings = await supplierSettings(admin, params.id);
  const { data: sup } = await admin.from("crm_company_directory").select("name").eq("id", params.id).maybeSingle();
  const kind: FeedKind = FEED_KINDS.includes(b.kind) ? b.kind : settings?.request_method === "pdf" ? "request_pdf" : "request";
  const tpl = await resolveFeedTemplate(admin, kind, params.id);
  const extra = {
    "supplier.name": sup?.name ?? "Supplier", "supplier.request_email": settings?.request_email ?? null,
    "approver.name": "Sample Approver", "approver.first_name": "Sample", "approver.email": "approver@example.com",
    "dealer.dms": settings?.is_dms ? settings.platform_provider ?? sup?.name : null,
    "approver.title": "General Manager",
    "order.id": "FO-SAMPLE", "order.sent_on": new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }), "order.feed_id": "MP12345",
    "order.case_number": "08000000",
    // The supplier's questions answered with their defaults / the example in their help text.
    ...supplierFieldContext(settings?.extra_fields ?? [], Object.fromEntries((settings?.extra_fields ?? []).map((f) => [f.key, f.default ?? /e\.g\.\s+([A-Z0-9]+)/.exec(f.help ?? "")?.[1] ?? "Sample"]))),
  };
  const rendered = await composeEmail({ subject: tpl.subject, bodyHtml: tpl.body_html, companyId: b.dealer_company_id, staffId: claims.sub, extraContext: extra }, admin);
  let pdf: any = null;
  if (kind === "request_pdf" || settings?.request_method === "pdf") {
    let bytes: Buffer, map = settings?.pdf_field_map ?? {};
    if (settings?.pdf_template_s3_key) {
      const s3 = new S3Client({ region: "us-west-1", credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID!, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY! } });
      const r = await s3.send(new GetObjectCommand({ Bucket: "dealer-addendums", Key: settings.pdf_template_s3_key }));
      bytes = Buffer.from(await (r.Body as any).transformToByteArray());
    } else { bytes = await samplePdfTemplate(); map = SAMPLE_PDF_FIELD_MAP; }
    const ctx = { ...(await buildTemplateContext({ companyId: b.dealer_company_id, staffId: claims.sub }, admin)), ...extra };
    const f = await fillRequestPdf(bytes, map, ctx);
    pdf = { sample: !settings?.pdf_template_s3_key, filled: f.filled, missingFields: f.missingFields, emptyValues: f.emptyValues, base64: f.bytes.toString("base64") };
  }
  const cc = settings?.request_method === "pdf" ? [] : [settings?.request_email, ...(settings?.cc_emails ?? [])].filter(Boolean);
  return NextResponse.json({ kind, templateSource: tpl.source, templateName: tpl.name, rendered, pdf, to: ["approver@example.com"], cc });
}
