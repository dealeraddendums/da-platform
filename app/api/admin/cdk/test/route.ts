import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { fetchCdkExtract, formatCdkDeltaDate, countCdkVehicles, cdkCredsConfigured } from "@/lib/cdk-api";

/**
 * POST /api/admin/cdk/test
 * Body: { dealer_id, icompany }
 *
 * Verifies connectivity to CDK for one dealer by running an IVEH_Bulk
 * extract with a 1-day deltaDate. Returns the vehicle count + raw status
 * so the UI can surface a green / red badge.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  if (!cdkCredsConfigured()) {
    return NextResponse.json({ error: "CDK API credentials not configured" }, { status: 500 });
  }

  let body: { dealer_id?: string; icompany?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const dealerId = body.dealer_id?.trim();
  const iCompany = body.icompany?.trim();
  if (!dealerId || !iCompany) {
    return NextResponse.json({ error: "dealer_id and icompany are required" }, { status: 400 });
  }

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const deltaDate = formatCdkDeltaDate(yesterday);

  try {
    const { status, bodyText, contentType } = await fetchCdkExtract({ dealerId, iCompany, deltaDate });
    if (status < 200 || status >= 300) {
      return NextResponse.json({
        success: false,
        error: `CDK returned HTTP ${status}`,
        body_preview: bodyText.slice(0, 300),
        status,
      }, { status: 200 });
    }
    const count = countCdkVehicles(bodyText);
    return NextResponse.json({ success: true, count, status, content_type: contentType });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 200 });
  }
}
