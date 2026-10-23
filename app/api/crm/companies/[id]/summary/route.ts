import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { generateCompanySummary, summaryState } from "@/lib/crm/company-summary";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * GET  /api/crm/companies/[id]/summary — the cached AI summary + whether it's due
 *      (new activity since the last run and an hour since it).
 * POST /api/crm/companies/[id]/summary { manual?: true } — generate when due
 *      (page view) or now (Refresh). Logged to crm_ai_generations.
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { error } = await requireCrmStaff();
  if (error) return error;
  const s = await summaryState(createAdminSupabaseClient(), params.id);
  return s ? NextResponse.json(s) : NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  const b = await req.json().catch(() => ({}));
  try {
    return NextResponse.json(await generateCompanySummary(createAdminSupabaseClient(), params.id, { manual: b?.manual === true, staffId: claims.sub }));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
  }
}
