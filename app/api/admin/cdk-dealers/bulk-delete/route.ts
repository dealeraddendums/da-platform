import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

/**
 * POST /api/admin/cdk-dealers/bulk-delete
 * Body: { dealer_ids: string[] }
 *
 * Hard-deletes every cdk_dealers row whose DEALER_ID is in the list.
 * Used by the "Remove All 401 Dealers" action on the CDK Dealers page.
 * super_admin only.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  let body: { dealer_ids?: unknown };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const ids = Array.isArray(body.dealer_ids)
    ? body.dealer_ids.map(s => String(s).trim()).filter(Boolean)
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "dealer_ids is required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: dbErr, count } = await (admin as any)
    .from("cdk_dealers")
    .delete({ count: "exact" })
    .in("DEALER_ID", ids);
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ ok: true, deleted: count ?? 0 });
}
