import { NextRequest, NextResponse } from "next/server";
import { requireRootAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

type Params = { params: { id: string } };

/**
 * POST /api/admin/users/[id]/impersonate
 * root_admin assumes the identity of the target dealer.
 *
 * Strategy: update the caller's app_metadata with impersonation context,
 * then issue a new session token. The impersonating_dealer_id claim is
 * checked in all dealer-scoped routes instead of the real dealer_id.
 */
export async function POST(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireRootAdmin();
  if (error) return error;

  const admin = createAdminSupabaseClient();

  // Look up the target user's dealer_id
  const { data: targetUser, error: fetchError } = await admin
    .from("users")
    .select("id, dealer_id, user_type, email")
    .eq("id", params.id)
    .single();

  if (fetchError || !targetUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Store impersonation context in the admin's app_metadata
  const { error: updateError } = await admin.auth.admin.updateUserById(
    claims.sub,
    {
      app_metadata: {
        user_type: claims.user_type,
        dealer_id: claims.dealer_id,
        impersonating_dealer_id: targetUser.dealer_id,
        impersonating_user_id: targetUser.id,
        real_user_id: claims.sub,
      },
    }
  );

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    impersonating: {
      user_id: targetUser.id,
      dealer_id: targetUser.dealer_id,
      email: targetUser.email,
    },
    message:
      "Impersonation active. Refresh your session token to pick up the new claims.",
  });
}
