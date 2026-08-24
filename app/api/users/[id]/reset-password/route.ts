import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient, fireWrite } from "@/lib/db";
import { authorizeDealerAction } from "@/lib/dealer-authz";

type Params = { params: { id: string } };

/**
 * POST /api/users/[id]/reset-password
 * Trigger a Supabase password-reset email for a sub-user. Authorized by the
 * canonical rule (super_admin any; dealer_admin own dealer; group_admin
 * in-group; group_user tag scope) rather than a bare claims.dealer_id match,
 * which previously 404'd for super_admin and group-context operators.
 */
export async function POST(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient();

  const { data: targetUser } = await admin
    .from("profiles")
    .select("id, email, dealer_id, group_id")
    .eq("id", params.id)
    .maybeSingle<{ id: string; email: string; dealer_id: string | null; group_id: string | null }>();

  if (!targetUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (claims.role !== "super_admin") {
    if (targetUser.dealer_id) {
      const authz = await authorizeDealerAction(claims, targetUser.dealer_id);
      if (!authz.ok) return authz.response;
    } else if (!(targetUser.group_id && claims.role === "group_admin" && claims.group_id === targetUser.group_id)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const { error: resetError } = await admin.auth.resetPasswordForEmail(
    targetUser.email,
    {
      redirectTo: `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/auth/update-password`,
    }
  );

  if (resetError) {
    return NextResponse.json({ error: resetError.message }, { status: 500 });
  }

  // Audit the trigger (2026-08-24): resetPasswordForEmail stamps GoTrue
  // recovery_sent_at, and the link's consumption stamps last_sign_in_at — an
  // operator-triggered reset previously left no trail while poisoning the
  // "has this human signed in" signal (Burns Honda invite skip).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fireWrite((admin as any).from("admin_audit").insert({
    admin_user_id: claims.sub,
    action: "send_user_reset_email",
    target_dealer_id: targetUser.dealer_id,
    metadata: { target_user_id: targetUser.id, target_email: targetUser.email },
  }), "admin_audit reset-password");

  return NextResponse.json({ success: true, message: "Password reset email sent" });
}
