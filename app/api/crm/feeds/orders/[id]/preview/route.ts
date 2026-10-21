import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { composeEmail } from "@/lib/crm/email-compose";
import { loadOrder, prepareRequest } from "@/lib/crm/feeds/orders";
import { feedErrorResponse } from "@/lib/crm/feeds/http";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * GET /api/crm/feeds/orders/[id]/preview — the request exactly as it would be
 * sent (template filled, Outlook-safe, signature) plus the raw template for
 * editing, recipients, the PDF report, and what's still missing.
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  const admin = createAdminSupabaseClient() as any;
  try {
    const order = await loadOrder(admin, params.id);
    const prep = await prepareRequest(admin, order);
    const rendered = await composeEmail({ subject: prep.subject, bodyHtml: prep.bodyHtml, companyId: order.dealer_company_id, staffId: claims.sub, extraContext: prep.context }, admin);
    return NextResponse.json({
      method: prep.method, kind: prep.kind, templateSource: prep.templateSource, subject: prep.subject, body_html: prep.bodyHtml,
      to: prep.to, cc: prep.cc, problems: prep.problems, rendered,
      pdf: prep.pdf ? { name: prep.pdf.name, size: prep.pdf.bytes.length, ...prep.pdf.report, base64: prep.pdf.bytes.toString("base64") } : null,
    });
  } catch (e) { return feedErrorResponse(e); }
}
