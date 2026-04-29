import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import type { UserRole } from "@/lib/db";

/**
 * POST /api/invite/accept
 * Accept an invitation: create auth user + profile, mark invitation accepted.
 * No auth required — this is called by a new user setting their password.
 * Body: { token, password }
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { token?: string; password?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { token, password } = body;
  if (!token)    return NextResponse.json({ error: "token required" }, { status: 400 });
  if (!password) return NextResponse.json({ error: "password required" }, { status: 400 });
  if (password.length < 6) return NextResponse.json({ error: "Password must be at least 6 characters" }, { status: 400 });

  const admin = createAdminSupabaseClient();

  // Validate token
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: inv } = await (admin as any)
    .from("invitations")
    .select("id, email, first_name, last_name, role, dealer_id, group_id, expires_at, accepted_at")
    .eq("token", token)
    .maybeSingle() as { data: {
      id: string; email: string; first_name: string; last_name: string;
      role: string; dealer_id: string | null; group_id: string | null;
      expires_at: string; accepted_at: string | null;
    } | null };

  if (!inv) return NextResponse.json({ error: "Invalid invitation" }, { status: 404 });
  if (inv.accepted_at) return NextResponse.json({ error: "Invitation already accepted" }, { status: 410 });
  if (new Date(inv.expires_at) < new Date()) return NextResponse.json({ error: "Invitation expired" }, { status: 410 });

  const isGroupInvite = !!inv.group_id && !inv.dealer_id;

  // For dealer invitations, resolve the dealer's text dealer_id
  let dealerTextId: string | null = null;
  if (!isGroupInvite) {
    const { data: dealer } = await admin
      .from("dealers")
      .select("dealer_id, name")
      .eq("id", inv.dealer_id!)
      .maybeSingle<{ dealer_id: string; name: string }>();

    if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });
    dealerTextId = dealer.dealer_id;
  }

  // Create auth user (admin API skips email confirmation)
  const fullName = `${inv.first_name} ${inv.last_name}`;
  const { data: authData, error: authErr } = await admin.auth.admin.createUser({
    email: inv.email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });

  if (authErr || !authData.user) {
    return NextResponse.json({ error: authErr?.message ?? "Failed to create account" }, { status: 400 });
  }

  // Create profile — group invites get group_id set, dealer invites get dealer_id set
  const { error: profileErr } = await admin.from("profiles").insert({
    id: authData.user.id,
    email: inv.email,
    full_name: fullName,
    role: inv.role as UserRole,
    dealer_id: isGroupInvite ? null : dealerTextId,
    group_id: isGroupInvite ? inv.group_id : null,
    active: true,
  });

  if (profileErr) {
    // Best-effort rollback auth user
    await admin.auth.admin.deleteUser(authData.user.id).catch(() => null);
    return NextResponse.json({ error: "Failed to create profile" }, { status: 500 });
  }

  // Mark invitation accepted
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from("invitations").update({ accepted_at: new Date().toISOString() }).eq("id", inv.id);

  // Sign the user in and return session tokens
  const { data: signInData, error: signInErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: inv.email,
  });

  if (signInErr || !signInData.properties?.hashed_token) {
    // Return success anyway — user can log in manually
    return NextResponse.json({ ok: true, manualLogin: true });
  }

  return NextResponse.json({
    ok: true,
    tokenHash: signInData.properties.hashed_token,
    email: inv.email,
  });
}
