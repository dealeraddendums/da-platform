import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient, fireWrite } from "@/lib/db";
import { sendMandrillEmail } from "@/lib/mandrill";
import { buildAccountReadyEmail, buildPasswordResetEmail } from "@/lib/invite-email";
import { loadAccessContext, refreshUserInvitation, NOT_ON_V5_MESSAGE } from "@/lib/user-access";

const ROLE_LABELS: Record<string, string> = {
  super_admin:       "Super Admin",
  group_admin:       "Group Admin",
  group_user:        "Regional Manager",
  dealer_admin:      "Dealer Admin",
  dealer_user:       "Dealer User",
  dealer_restricted: "Dealer Restricted",
};

/**
 * POST /api/users/[id]/send-invite
 *
 * Send an existing user their credentials: a scanner-proof 8-digit setup code
 * + inert /signup?invite= link (same machinery as staff invites — the accept
 * path updates an existing auth user in place, so this doubles as a password
 * reset). Copy varies: never-signed-in users get "your account is ready",
 * previously-signed-in users get "reset your password".
 *
 * WHO (2026-10-02): super_admin — anyone, both modes (unchanged). The user's
 * managing admin (dealer_admin own dealer, group_admin own group, group_user
 * scoped dealer) — ONLY for a user who has NEVER signed in, on a dealer that is
 * on 5.0 ("Resend invite" on the Users tab). Gated in lib/user-access.ts.
 *
 * The invitation row is built from the target's CURRENT profile (role,
 * dealer, group), so acceptance rewrites the profile with the same values.
 * Re-sending replaces the old setup code (old code dead, same token/link) and
 * reopens an expired or already-consumed row.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient();
  const loaded = await loadAccessContext(admin, claims, params.id);
  if (!loaded.ok) return loaded.response;
  const ctx = loaded.ctx;
  const isSuper = claims.role === "super_admin";

  if (!isSuper) {
    if (!ctx.neverSignedIn) {
      return NextResponse.json({ error: "This user has already signed in — they can use \"Forgot password\" or an email sign-in code on the login page." }, { status: 409 });
    }
    if (ctx.dealerNotOnV5) return NextResponse.json({ error: NOT_ON_V5_MESSAGE }, { status: 409 });
  }

  const { target } = ctx;
  const email = target.email.trim();
  const firstName = (target.full_name ?? "").trim().split(/\s+/).filter(Boolean)[0] ?? email.split("@")[0];
  // Invite vs reset: STRICT sign-in (see lib/user-access.ts). Both modes
  // deliver a usable setup code, so erring toward "invite" is harmless.
  const mode: "invite" | "reset" = ctx.neverSignedIn ? "invite" : "reset";

  let inv: Awaited<ReturnType<typeof refreshUserInvitation>>;
  try {
    inv = await refreshUserInvitation(admin, ctx, claims.sub);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to create invitation" }, { status: 500 });
  }

  const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? "https://app.dealeraddendums.com"}/signup?invite=${inv.token}`;
  const roleLabel = ROLE_LABELS[target.role] ?? target.role;

  try {
    await sendMandrillEmail({
      subject: mode === "invite"
        ? "Your DealerAddendums 5.0 account is ready"
        : "Reset your DealerAddendums 5.0 password",
      from_email: "noreply@dealeraddendums.com",
      from_name: "DealerAddendums",
      to: [{ email, name: target.full_name ?? email, type: "to" }],
      html: mode === "invite"
        ? buildAccountReadyEmail({ firstName, email, roleLabel, orgName: inv.orgName, inviteUrl, setupCode: inv.code })
        : buildPasswordResetEmail({ firstName, email, inviteUrl, setupCode: inv.code }),
    });
  } catch (emailErr) {
    const detail = emailErr instanceof Error ? emailErr.message : "send failed";
    console.error("[send-invite] Mandrill send failed:", detail);
    return NextResponse.json({ error: `Email could not be delivered: ${detail}` }, { status: 502 });
  }

  fireWrite(admin.from("admin_audit").insert({
    admin_user_id: claims.sub,
    action: mode === "invite" ? "send_user_invite" : "send_user_reset_email",
    target_dealer_id: target.dealer_id,
    metadata: { target_user_id: target.id, email, role: target.role, mode, invitation_id: inv.invitationId, expires_at: inv.expiresAt, actor_role: claims.role },
  }), "admin_audit");

  return NextResponse.json({ ok: true, mode, email, expiresAt: inv.expiresAt });
}
