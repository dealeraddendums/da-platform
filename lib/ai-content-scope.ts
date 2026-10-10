// Which dealer may an /api/ai-content* call read/write? (2026-10-09)
//
// ALWAYS the session's dealer — never a dealer id from the request. Before this
// fix `GET /api/ai-content?dealer_id=` and `POST /api/ai-content/regenerate
// {dealer_id}` took it from the browser, so any logged-in user could read, or
// overwrite, another dealer's cached AI vehicle content (cross-tenant write).
//
// Same resolution as /api/ai-content/vehicle-description and Edit Vehicle's
// save (PATCH /api/dealer-vehicles/[id]): an impersonated dealer, a super_admin's
// ghosted dealer, a group_admin / group_user's switched-into dealer, or a
// dealer user's own store. A platform- or group-level admin with no dealer
// context is refused, as is dealer_restricted. Re-checked through
// authorizeDealerAction (tag scope for group_user, group membership for
// group_admin).

import { NextResponse } from "next/server";
import type { JwtClaims } from "@/lib/auth";
import { authorizeDealerAction } from "@/lib/dealer-authz";

export async function resolveAiContentDealer(claims: JwtClaims): Promise<{ ok: true; dealerId: string } | { ok: false; response: NextResponse }> {
  const isAdminLevel = (claims.role === "super_admin" || claims.role === "group_admin")
    && !claims.impersonating_dealer_id && !claims.is_ghost && !claims.active_dealer_id;
  const dealerId = claims.impersonating_dealer_id ?? claims.dealer_id;
  if (isAdminLevel || !dealerId) {
    return { ok: false, response: NextResponse.json({ error: "Switch into a dealership to use AI content." }, { status: 403 }) };
  }
  if (claims.role === "dealer_restricted") return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  const authz = await authorizeDealerAction(claims, dealerId);
  if (!authz.ok) return { ok: false, response: authz.response };
  return { ok: true, dealerId };
}
