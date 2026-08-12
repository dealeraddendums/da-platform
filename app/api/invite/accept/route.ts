import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import type { UserRole } from "@/lib/db";
import { fireProfileSync } from "@/lib/sync-hubspot";
import { verifySetupCode } from "@/lib/invite-code";
import { getAuthUserIdByEmail } from "@/lib/last-sign-in";
import { rateLimit } from "@/lib/rate-limit";
import { setUserDirectScope } from "@/lib/tags";

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
    .select("id, email, first_name, last_name, role, dealer_id, group_id, expires_at, accepted_at, setup_code_hash, setup_code_expires_at, scope_tag_ids, scope_dealer_ids, invited_by")
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
  // Staff invite (admin Users page "Send invite"): no dealer AND no group —
  // super_admin or other org-less users. No dealer/group resolution needed.
  const isStaffInvite = !inv.dealer_id && !inv.group_id;

  // For dealer invitations, resolve the dealer's text dealer_id
  let dealerTextId: string | null = null;
  if (!isGroupInvite && !isStaffInvite) {
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
  // A brand-new createUser sets role (+ password) in one shot. For an existing
  // user (a prior partial attempt) we resolve the id and patch role/password.
  const fullName = [inv.first_name, inv.last_name].filter(Boolean).join(" ");
  const { data: createData, error: createErr } = await admin.auth.admin.createUser({
    email: inv.email,
    ...(usingPassword ? { password } : {}),
    email_confirm: true,
    user_metadata: { full_name: fullName },
    app_metadata: { role: inv.role },
  });

  let userId = createData?.user?.id ?? null;
  if (!userId) {
    // Already registered from a prior attempt — resolve without issuing a token.
    userId = await getAuthUserIdByEmail(inv.email);
    if (userId) {
      await admin.auth.admin.updateUserById(userId, {
        app_metadata: { role: inv.role },
        ...(usingPassword ? { password } : {}),
      }).catch(() => null);
    }
  }

  if (!userId) {
    console.error("[invite/accept] could not create or resolve user:", createErr?.message);
    return NextResponse.json({ error: createErr?.message ?? "Failed to create account" }, { status: 400 });
  }

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

  // Invite-time store tags (2026-08-12, migration 141): a group_user
  // invitation can carry the tag scope picked in the invite form — apply it
  // now so the Regional Manager sees their stores on first sign-in, no
  // separate assignment step. Failures are logged, never block acceptance.
  const invExtra = inv as { scope_tag_ids?: string[] | null; scope_dealer_ids?: string[] | null; invited_by?: string | null };
  const scopeTagIds = invExtra.scope_tag_ids ?? null;
  const scopeDealerIds = invExtra.scope_dealer_ids ?? null;
  if (inv.role === "group_user" && ((scopeTagIds?.length ?? 0) > 0 || (scopeDealerIds?.length ?? 0) > 0)) {
    try {
      // user_tags/admin_audit aren't in the generated Database types (same
      // convention as the tags route) — cast through any.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adminAny = admin as any;
      await adminAny.from("user_tags").delete().eq("user_id", userId);
      if (scopeTagIds?.length) {
        const { error: tagErr } = await adminAny
          .from("user_tags")
          .insert(scopeTagIds.map((tag_id: string) => ({ user_id: userId, tag_id, created_by: invExtra.invited_by ?? null })));
        if (tagErr) console.error("[invite/accept] user_tags insert failed:", tagErr.message);
      }
      // Direct dealer selection (migration 142) → the user's hidden system
      // tag + dealer_tags + user_tags link, all in one reconcile.
      if (scopeDealerIds?.length && inv.group_id) {
        const scopeErr = await setUserDirectScope(admin, {
          userId, groupId: inv.group_id, dealerIds: scopeDealerIds,
          actorId: invExtra.invited_by ?? null,
        });
        if (scopeErr) console.error("[invite/accept] direct dealer scope failed:", scopeErr);
      }
      await adminAny.from("admin_audit").insert({
        admin_user_id: invExtra.invited_by ?? userId,
        action: "user_scope_tags_set",
        metadata: {
          user_id: userId,
          tag_ids: scopeTagIds ?? [], count: scopeTagIds?.length ?? 0,
          dealer_ids: scopeDealerIds ?? [], dealer_count: scopeDealerIds?.length ?? 0,
          source: "invite_acceptance",
        },
      });
    } catch (e) {
      console.error("[invite/accept] invite-time scope apply failed:", e instanceof Error ? e.message : e);
    }
  }

  // Phase 14a — HubSpot Contact upsert. Fire-and-forget.
  fireProfileSync(userId);

  // Consume the invitation: mark accepted and burn the setup code so it can't
  // be reused. Done only now, after a verified human action.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from("invitations")
    .update({ accepted_at: new Date().toISOString(), setup_code_hash: null })
    .eq("id", inv.id);

  // Password path: the client signs in with the password it just set — no token
  // needed (and issuing one here then setting a password would invalidate it).
  if (usingPassword) {
    return NextResponse.json({ ok: true, email: inv.email });
  }

  // Code path: issue the magic-link token LAST (after all user mutations) so it
  // can't be invalidated, then the client verifies it to establish a session.
  const { data: linkData } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: inv.email,
  });
  if (!linkData?.properties?.hashed_token) {
    return NextResponse.json({ ok: true, manualLogin: true });
  }
  return NextResponse.json({
    ok: true,
    tokenHash: linkData.properties.hashed_token,
    email: inv.email,
  });
}
