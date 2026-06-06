import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

/**
 * GET /api/help/conversations
 *  - super_admin: review queue. ?status=escalated|open|resolved, ?flagged=1.
 *  - other roles: their own conversations only.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient();
  const sp = req.nextUrl.searchParams;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = (admin as any)
    .from("help_conversations")
    .select("id, user_id, dealer_id, role, status, flagged, escalated_at, resolved_at, hubspot_logged_at, created_at, updated_at")
    .order("flagged", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(200);

  if (claims.role === "super_admin") {
    const status = sp.get("status");
    if (status && ["open", "escalated", "resolved"].includes(status)) q = q.eq("status", status);
    if (sp.get("flagged") === "1") q = q.eq("flagged", true);
  } else {
    q = q.eq("user_id", claims.sub);
  }

  const { data, error: dbErr } = await q;
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}
