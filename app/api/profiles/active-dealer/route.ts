import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { authorizeDealerAction } from "@/lib/dealer-authz";
import {
  ACTIVE_DEALER_COOKIE,
  ACTIVE_DEALER_COOKIE_OPTIONS,
  encodeActiveDealerCookie,
} from "@/lib/active-dealer";

/**
 * PATCH /api/profiles/active-dealer
 * Sets or clears the active dealer for a group_admin or a group_user
 * (regional manager). Body: { dealerId: string | null }
 *
 * The selection is SESSION/DEVICE scoped (httpOnly cookie, lib/active-dealer.ts),
 * not per-user: switching here must never move another session of the same
 * login. `profiles.active_dealer_id` is still written as a non-authoritative
 * "last dealer" record, but nothing resolves dealer context from it any more —
 * see the module header in lib/active-dealer.ts.
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
    // authorizeDealerAction (by text dealer_id) centralizes both checks. This is
    // the set-time gate; resolveActiveDealer re-runs the same checks on EVERY
    // request, so a cookie that outlives the grant stops working immediately.
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

  // Non-authoritative: kept so "last dealer" reporting and a rollback path stay
  // intact. Dealer CONTEXT comes from the cookie set below, never from here.
  const { error: updateErr } = await admin
    .from("profiles")
    .update({ active_dealer_id: dealerUuid })
    .eq("id", claims.sub);

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  // `dealerId` is echoed for headless clients (iOS store picker): they store it
  // and send it back as the X-DA-Active-Dealer header, since a native client may
  // not share the browser cookie jar.
  const res = NextResponse.json({ ok: true, dealerId: dealerUuid });

  // THE authority: this session's dealer context, bound to this auth user.
  if (dealerUuid) {
    res.cookies.set(
      ACTIVE_DEALER_COOKIE,
      encodeActiveDealerCookie(claims.sub, dealerUuid),
      ACTIVE_DEALER_COOKIE_OPTIONS,
    );
  } else {
    res.cookies.set(ACTIVE_DEALER_COOKIE, "", { ...ACTIVE_DEALER_COOKIE_OPTIONS, maxAge: 0 });
  }

  // Explicitly switching dealers clears the #116 session-layer group-level reset
  // so this choice is honored from now on.
  res.cookies.set("da_group_level", "", { path: "/", maxAge: 0 });
  return res;
}
