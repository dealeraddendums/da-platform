import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import type { UserRole } from "@/lib/db";
import { fireProfileSync } from "@/lib/sync-hubspot";
import { verifySetupCode } from "@/lib/invite-code";
import { rateLimit } from "@/lib/rate-limit";

/**
 * POST /api/invite/accept
 * Finalize an invitation — SCANNER-PROOF: the account is created and the
 * invitation is consumed ONLY here, on a human action:
 *   - { token, code }     → verify the emailed one-time setup code, then finalize.
 *   - { token, password } → set a password, then finalize.
 *
 * Neither loading the invite page nor any GET/HEAD pre-fetch consumes anything.
 * A mail scanner can pre-touch the link but can't read & type the code, so it
 * cannot reach this consume step. No auth required (the user has no account yet).
 *
 * Idempotent: if a prior partial attempt left a half-created user, finalize
 * resolves the existing auth user instead of erroring.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!rateLimit(`invite-accept:${ip}`, 10, 60_000)) {
    return NextResponse.json({ error: "Too many attempts — please wait a moment." }, { status: 429 });
  }

  let body: { token?: string; code?: string; password?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { token, code, password } = body;
  if (!token) return NextResponse.json({ error: "token required" }, { status: 400 });

  const usingPassword = !!password;
  if (!usingPassword && !code) {
    return NextResponse.json({ error: "A setup code or password is required." }, { status: 400 });
  }
  if (usingPassword && password!.length < 6) {
    return NextResponse.json({ error: "Password must be at least 6 characters" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // Validate token
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: inv } = await (admin as any)
    .from("invitations")
    .select("id, email, first_name, last_name, role, dealer_id, group_id, expires_at, accepted_at, setup_code_hash, setup_code_expires_at")
    .eq("token", token)
    .maybeSingle() as { data: {
      id: string; email: string; first_name: string; last_name: string;
      role: string; dealer_id: string | null; group_id: string | null;
      expires_at: string; accepted_at: string | null;
      setup_code_hash: string | null; setup_code_expires_at: string | null;
    } | null };

  if (!inv) return NextResponse.json({ error: "Invalid invitation" }, { status: 404 });
  if (new Date(inv.expires_at) < new Date()) return NextResponse.json({ error: "This invitation has expired. Ask your administrator to resend it." }, { status: 410 });

  // Code path: verify the one-time setup code (the scanner-proof gate).
  if (!usingPassword) {
    const codeExpired = inv.setup_code_expires_at ? new Date(inv.setup_code_expires_at) < new Date() : true;
    if (!inv.setup_code_hash || codeExpired) {
      return NextResponse.json({ error: "Your setup code has expired. Use “Resend code” to get a new one." }, { status: 410 });
    }
    if (!verifySetupCode(code!.trim(), inv.setup_code_hash)) {
      return NextResponse.json({ error: "That code is incorrect. Check your email or request a new one." }, { status: 401 });
    }
  }

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

  // ── Create or resolve the auth user (idempotent) ──────────────────────────
  // Set the role in app_metadata so the JWT carries it on first sign-in (the
  // user lands AS the invited role — no leftover impersonation/ghost context).
  const fullName = `${inv.first_name} ${inv.last_name}`;
  const { data: createData, error: createErr } = await admin.auth.admin.createUser({
    email: inv.email,
    ...(usingPassword ? { password } : {}),
    email_confirm: true,
    user_metadata: { full_name: fullName },
    app_metadata: { role: inv.role },
  });

  let userId = createData?.user?.id ?? null;

  // generateLink resolves an already-existing user (a prior partial attempt) and
  // gives us the magic-link token to sign the user in.
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: inv.email,
  });
  if (linkData?.user?.id) userId = linkData.user.id;

  if (!userId) {
    console.error("[invite/accept] could not create or resolve user:", createErr?.message ?? linkErr?.message);
    return NextResponse.json({ error: createErr?.message ?? "Failed to create account" }, { status: 400 });
  }

  // Ensure role + password are applied even when the user already existed.
  await admin.auth.admin.updateUserById(userId, {
    app_metadata: { role: inv.role },
    ...(usingPassword ? { password } : {}),
  }).catch(() => null);

  // Upsert profile — handle_new_user trigger (migration 001) auto-creates a
  // minimal row on auth.users INSERT, so a plain .insert() races into a
  // primary-key violation. Upsert by id rewrites the row with the invite payload.
  const { error: profileErr } = await admin.from("profiles").upsert({
    id: userId,
    email: inv.email,
    full_name: fullName,
    role: inv.role as UserRole,
    dealer_id: isGroupInvite ? null : dealerTextId,
    group_id: isGroupInvite ? inv.group_id : null,
    active: true,
  }, { onConflict: "id" });

  if (profileErr) {
    console.error("[invite/accept] profile upsert failed:", profileErr.message);
    return NextResponse.json({ error: "Failed to create profile" }, { status: 500 });
  }

  // Phase 14a — HubSpot Contact upsert. Fire-and-forget.
  fireProfileSync(userId);

  // Consume the invitation: mark accepted and burn the setup code so it can't
  // be reused. Done only now, after a verified human action.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from("invitations")
    .update({ accepted_at: new Date().toISOString(), setup_code_hash: null })
    .eq("id", inv.id);

  if (!linkData?.properties?.hashed_token) {
    // Account is finalized; user can sign in manually if the token is missing.
    return NextResponse.json({ ok: true, manualLogin: true });
  }

  return NextResponse.json({
    ok: true,
    tokenHash: linkData.properties.hashed_token,
    email: inv.email,
  });
}
