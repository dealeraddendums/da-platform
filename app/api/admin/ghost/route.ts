import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { signGhostToken } from "@/lib/ghost";

/**
 * POST /api/admin/ghost
 * super_admin only. Enter ghost mode for a dealer without swapping the JWT.
 * Sets a signed httpOnly cookie that overlays dealer context on the super_admin session.
 * Body: { dealer_id: string }  — the UUID (dealers.id)
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

  const { dealer_id: dealerUuid } = body;
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
  const token = signGhostToken({
    dealer_id: dealer.id,
    dealer_text_id: dealer.dealer_id,
    dealer_name: dealer.name,
    super_admin_id: claims.sub,
    issued_at: now,
    expires_at: now + 7_200_000, // 2 hours
  });

  // Log — fire and forget
  void admin.from("admin_audit").insert({
    admin_user_id: claims.sub,
    action: "ghost_mode_enter",
    target_dealer_id: dealer.dealer_id,
    metadata: { dealer_name: dealer.name, dealer_uuid: dealer.id },
  });

  const res = NextResponse.json({
    ok: true,
    dealer_text_id: dealer.dealer_id,
    dealer_name: dealer.name,
    dealer_uuid: dealer.id,
  });

  res.cookies.set("da_ghost_token", token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 7200,
  });

  return res;
}
