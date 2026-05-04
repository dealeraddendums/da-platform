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

  let body: { dealer_id?: string; group_id?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { dealer_id: dealerUuid, group_id: groupUuid } = body;
  if (!dealerUuid && !groupUuid) {
    return NextResponse.json({ error: "dealer_id or group_id (UUID) required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const now = Date.now();

  // ── Group ghost mode ──────────────────────────────────────────────────────
  if (groupUuid) {
    const { data: group } = await admin
      .from("groups")
      .select("id, name")
      .eq("id", groupUuid)
      .maybeSingle<{ id: string; name: string }>();

    if (!group) {
      return NextResponse.json({ error: "Group not found" }, { status: 404 });
    }

    const token = signGhostToken({
      group_id: group.id,
      group_name: group.name,
      super_admin_id: claims.sub,
      issued_at: now,
      expires_at: now + 7_200_000,
    });

    void admin.from("admin_audit").insert({
      admin_user_id: claims.sub,
      action: "ghost_mode_enter",
      metadata: { group_name: group.name, group_id: group.id },
    });

    const res = NextResponse.json({ ok: true, group_id: group.id, group_name: group.name });
    res.cookies.set("da_ghost_token", token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 7200 });
    return res;
  }

  // ── Dealer ghost mode ─────────────────────────────────────────────────────
  const { data: dealer } = await admin
    .from("dealers")
    .select("id, dealer_id, name")
    .eq("id", dealerUuid!)
    .maybeSingle<{ id: string; dealer_id: string; name: string }>();

  if (!dealer) {
    return NextResponse.json({ error: "Dealer not found" }, { status: 404 });
  }

  const token = signGhostToken({
    dealer_id: dealer.id,
    dealer_text_id: dealer.dealer_id,
    dealer_name: dealer.name,
    super_admin_id: claims.sub,
    issued_at: now,
    expires_at: now + 7_200_000,
  });

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
