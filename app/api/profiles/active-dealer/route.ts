import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

/**
 * PATCH /api/profiles/active-dealer
 * Sets or clears the active_dealer_id for a group_admin.
 * Body: { dealerId: string | null }
 */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (claims.role !== "group_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { dealerId?: string | null };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const dealerUuid = body.dealerId ?? null;
  const admin = createAdminSupabaseClient();

  if (dealerUuid) {
    // Security: verify this dealer belongs to the group_admin's group
    const { data: dealer } = await admin
      .from("dealers")
      .select("id, group_id")
      .eq("id", dealerUuid)
      .maybeSingle<{ id: string; group_id: string | null }>();

    if (!dealer || dealer.group_id !== claims.group_id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const { error: updateErr } = await admin
    .from("profiles")
    .update({ active_dealer_id: dealerUuid })
    .eq("id", claims.sub);

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
