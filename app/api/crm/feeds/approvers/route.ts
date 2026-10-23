import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { approverCandidates } from "@/lib/crm/feeds/approver";
import { UUID } from "@/lib/crm/feeds/http";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * GET /api/crm/feeds/approvers?company_id= — the Start feed order approver picker: the company's
 * contacts, plus its group's when it's a group dealer (company_label = the group name). Past approvers
 * first, then platform users (lib/crm/feeds/approver.ts).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireCrmStaff();
  if (error) return error;
  const id = req.nextUrl.searchParams.get("company_id") ?? "";
  if (!UUID.test(id)) return NextResponse.json({ error: "company_id required" }, { status: 400 });
  return NextResponse.json({ contacts: await approverCandidates(createAdminSupabaseClient() as any, id) });
}
