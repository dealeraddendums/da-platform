// GET /api/admin/bi?from=&to= — full Business Intelligence report JSON.
// super_admin only. Spec: docs/superadmin-bi-tab.md.
//
// from/to are YYYY-MM-DD inclusive dates. Omitted → previous calendar month.

import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { buildBiReport } from "@/lib/bi";
import { resolvePeriod } from "@/lib/bi-period";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const { from, to, errorResponse } = resolvePeriod(
    req.nextUrl.searchParams.get("from"),
    req.nextUrl.searchParams.get("to"),
  );
  if (errorResponse) return errorResponse;

  try {
    const report = await buildBiReport(from, to);
    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to build report" },
      { status: 500 },
    );
  }
}
