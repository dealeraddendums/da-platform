import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { authorizeDealerAction } from "@/lib/dealer-authz";

/**
 * PATCH /api/profiles/active-dealer
 * Sets or clears the active_dealer_id for a group_admin or a group_user
 * (regional manager). Body: { dealerId: string | null }
 */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (claims.role !== "group_admin" && claims.role !== "group_user") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { dealerId?: string | null };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const dealerUuid = body.dealerId ?? null;
  const admin = createAdminSupabaseClient();

  if (dealerUuid) {
    // Verify the target dealer is switch-able for this caller:
    //   group_admin → in their group · group_user → in-group AND tagged for them.
    // authorizeDealerAction (by text dealer_id) centralizes both checks.
    const { data: dealer } = await admin
      .from("dealers")
      .select("id, dealer_id, group_id")
      .eq("id", dealerUuid)
      .maybeSingle<{ id: string; dealer_id: string; group_id: string | null }>();

    if (!dealer) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const authz = await authorizeDealerAction(claims, dealer.dealer_id);
    if (!authz.ok) return authz.response;
  }

  const { error: updateErr } = await admin
    .from("profiles")
    .update({ active_dealer_id: dealerUuid })
    .eq("id", claims.sub);

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  // Explicitly switching dealers clears the #116 session-layer group-level reset
  // so this choice (and the persisted profile value) is honored from now on.
  const res = NextResponse.json({ ok: true });
  res.cookies.set("da_group_level", "", { path: "/", maxAge: 0 });
  return res;
}
