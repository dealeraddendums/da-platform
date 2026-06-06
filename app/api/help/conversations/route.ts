import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { listConversations } from "@/lib/help-conversations";

/**
 * GET /api/help/conversations
 *  - super_admin: review queue. ?status=escalated|open|resolved, ?flagged=1.
 *  - other roles: their own conversations only (hard-scoped in listConversations).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const sp = req.nextUrl.searchParams;
  const { data, error: dbErr } = await listConversations(claims, {
    status: sp.get("status"),
    flagged: sp.get("flagged") === "1",
  });
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data });
}
