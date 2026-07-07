import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { signGhostToken } from "@/lib/ghost";

/**
 * POST /api/auth/ghost
 * super_admin only. Mint a ghost token for mobile operate-as
 * (IOS-APP-SPEC §4.2/§8.4): unlike POST /api/admin/ghost (which sets the
 * httpOnly da_ghost_token cookie for the web admin panel), this returns the
 * token in the JSON body so the iOS app can send it back as the
 * X-DA-Ghost-Token header. Same signing code, claims, and 2-hour TTL as the
 * cookie flow — verification (lib/ghost.ts verifyGhostToken) is identical.
 *
 * Body: { dealer_id: string }  — the UUID (dealers.id)
 * → { token, expires_at, dealer_uuid, dealer_text_id, dealer_name }
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  let body: { dealer_id?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const dealerUuid = body.dealer_id;
  if (!dealerUuid) {
    return NextResponse.json({ error: "dealer_id (UUID) required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  const { data: dealer } = await admin
    .from("dealers")
    .select("id, dealer_id, name")
    .eq("id", dealerUuid)
    .maybeSingle<{ id: string; dealer_id: string; name: string }>();

  if (!dealer) {
    return NextResponse.json({ error: "Dealer not found" }, { status: 404 });
  }

  const now = Date.now();
  const expiresAt = now + 7_200_000; // 2 hours — same TTL as the cookie flow

  const token = signGhostToken({
    dealer_id: dealer.id,
    dealer_text_id: dealer.dealer_id,
    dealer_name: dealer.name,
    super_admin_id: claims.sub,
    issued_at: now,
    expires_at: expiresAt,
  });

  void admin.from("admin_audit").insert({
    admin_user_id: claims.sub,
    action: "ghost_mode_enter",
    target_dealer_id: dealer.dealer_id,
    metadata: { dealer_name: dealer.name, dealer_uuid: dealer.id, via: "header" },
  });

  return NextResponse.json({
    token,
    expires_at: new Date(expiresAt).toISOString(),
    dealer_uuid: dealer.id,
    dealer_text_id: dealer.dealer_id,
    dealer_name: dealer.name,
  });
}
