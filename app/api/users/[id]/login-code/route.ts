import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { loadAccessContext, refreshUserInvitation } from "@/lib/user-access";
import { issueMigrationLoginCode } from "@/lib/migration-login-code";

export const dynamic = "force-dynamic";

/**
 * POST /api/users/[id]/login-code — Users tab "Login code" (2026-10-02).
 *
 * For a user who has NEVER signed in and isn't getting their invite email:
 * mints a fresh setup code on their invitation (reopening it if it expired or
 * was consumed) and RETURNS it so support can read it over the phone. Nothing
 * is emailed — "Resend invite" does that. The user goes to /signup, enters
 * their email + this code, and lands signed in (an existing auth user is
 * updated in place by /api/invite/accept).
 *
 * Codes are stored only as a SHA-256 hash, so an emailed code can never be
 * shown; this REPLACES it (the emailed one stops working).
 *
 * Gate (server-side, lib/user-access.ts): the user's managing admin —
 * super_admin, dealer_admin of their dealer, group_admin of their group,
 * group_user over a scoped dealer. Never-signed-in users ONLY, for every role.
 * The admin_audit row is written (awaited) BEFORE the code exists — no audit,
 * no code. The code is never logged.
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

  if (!ctx.neverSignedIn) {
    return NextResponse.json({ error: "This user has already signed in — a login code is only for someone who has never signed in. They can use \"Forgot password\" or an email sign-in code on the login page." }, { status: 409 });
  }
  if (ctx.target.active === false) {
    return NextResponse.json({ error: "This user is inactive — reactivate them first." }, { status: 409 });
  }
  // Dealer still on 4.0 → their code is the dealer's MIGRATION code, issued by
  // the Migration Console's own mechanism (2026-10-09).
  if (ctx.dealerNotOnV5 && ctx.dealer) {
    const r = await issueMigrationLoginCode(admin, claims, {
      dealerUuid: ctx.dealer.id, email: ctx.target.email, role: ctx.target.role,
      name: ctx.target.full_name, source: "user", sourceId: ctx.target.id,
    });
    return r.ok
      ? NextResponse.json({ ok: true, code: r.code, email: r.email, expiresAt: r.expiresAt, kind: r.kind, dealerName: r.dealerName }, { headers: { "Cache-Control": "no-store" } })
      : NextResponse.json({ error: r.error }, { status: r.status });
  }

  const { error: auditErr } = await admin.from("admin_audit").insert({
    admin_user_id: claims.sub,
    action: "user_login_code_generated",
    target_dealer_id: ctx.target.dealer_id,
    metadata: {
      target_user_id: ctx.target.id,
      email: ctx.target.email,
      role: ctx.target.role,
      group_id: ctx.target.group_id,
      actor_role: claims.role,
      channel: "phone",
    },
  });
  if (auditErr) {
    console.error("[users/login-code] audit write failed — no code generated:", auditErr.message);
    return NextResponse.json({ error: "Could not record the audit entry, so no code was generated. Try again." }, { status: 500 });
  }

  let inv: Awaited<ReturnType<typeof refreshUserInvitation>>;
  try {
    inv = await refreshUserInvitation(admin, ctx, claims.sub);
  } catch (e) {
    console.error("[users/login-code] invitation refresh failed for user", ctx.target.id, e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Could not set the new code. Try again." }, { status: 500 });
  }

  return NextResponse.json(
    { ok: true, code: inv.code, email: ctx.target.email, expiresAt: inv.expiresAt, orgName: inv.orgName, kind: "setup" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
