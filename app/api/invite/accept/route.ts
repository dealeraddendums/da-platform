import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import type { UserRole } from "@/lib/db";
import { fireProfileSync } from "@/lib/sync-hubspot";
import { sendOtpCode } from "@/lib/migration-invite";

/**
 * POST /api/invite/accept
 * Accept an invitation: create auth user + profile, mark invitation accepted.
 * No auth required — this is called by a new user finishing setup.
 *
 * Body: { token, password? }
 *   - password present  → password account; client signs in with the returned
 *     magic-link token_hash.
 *   - password omitted  → passwordless account; we email a 6-digit sign-in code
 *     (the existing /onboard OTP flow) and the client verifies it. Most dealers
 *     are non-technical, so the invite UI lets them choose this path.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { token?: string; password?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { token, password } = body;
  if (!token) return NextResponse.json({ error: "token required" }, { status: 400 });
  const passwordless = !password;
  if (!passwordless && password!.length < 6) {
    return NextResponse.json({ error: "Password must be at least 6 characters" }, { status: 400 });
  }

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

  // Create auth user (admin API skips email confirmation). Set the role in
  // app_metadata so the JWT carries it on first sign-in (the user lands AS the
  // invited role — no leftover impersonation/ghost context). Passwordless
  // accounts are created with no password and sign in via the emailed OTP code.
  const fullName = `${inv.first_name} ${inv.last_name}`;
  const { data: authData, error: authErr } = await admin.auth.admin.createUser({
    email: inv.email,
    ...(passwordless ? {} : { password }),
    email_confirm: true,
    user_metadata: { full_name: fullName },
    app_metadata: { role: inv.role },
  });

  if (authErr || !authData.user) {
    return NextResponse.json({ error: authErr?.message ?? "Failed to create account" }, { status: 400 });
  }

  // Upsert profile — handle_new_user trigger (migration 001) auto-creates a
  // minimal row on auth.users INSERT with role from app_metadata and no
  // dealer/group binding, so a plain .insert() races into a primary-key
  // violation. Upsert by id rewrites the row with the full invite payload.
  const { error: profileErr } = await admin.from("profiles").upsert({
    id: authData.user.id,
    email: inv.email,
    full_name: fullName,
    role: inv.role as UserRole,
    dealer_id: isGroupInvite ? null : dealerTextId,
    group_id: isGroupInvite ? inv.group_id : null,
    active: true,
  }, { onConflict: "id" });

  if (profileErr) {
    // Best-effort rollback auth user
    await admin.auth.admin.deleteUser(authData.user.id).catch(() => null);
    console.error("[invite/accept] profile upsert failed:", profileErr.message);
    return NextResponse.json({ error: "Failed to create profile" }, { status: 500 });
  }

  // Phase 14a — HubSpot Contact upsert for the new user. Fire-and-forget;
  // if HubSpot is down the invite still succeeds and 14b cron will catch up.
  fireProfileSync(authData.user.id);

  // Mark invitation accepted
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from("invitations").update({ accepted_at: new Date().toISOString() }).eq("id", inv.id);

  // Passwordless: email a 6-digit code; the client collects it and calls
  // verifyOtp({ email, token, type: "email" }) to establish a real session.
  if (passwordless) {
    try {
      await sendOtpCode(inv.email, { purpose: "onboard", fullName, entityName: "your account" });
    } catch (e) {
      console.error("[invite/accept] sendOtpCode failed:", e instanceof Error ? e.message : e);
      return NextResponse.json({ error: "Account created, but we couldn't email your sign-in code. Please use “Email me a code” on the login page." }, { status: 502 });
    }
    return NextResponse.json({ ok: true, passwordless: true, email: inv.email });
  }

  // Password path: sign the user in via a magic-link token_hash.
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
