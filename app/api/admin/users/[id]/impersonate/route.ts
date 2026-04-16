import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

type Params = { params: { id: string } };

/**
 * POST /api/admin/users/[id]/impersonate
 * super_admin assumes the identity of a target dealer user.
 */
export async function POST(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  const admin = createAdminSupabaseClient();

  const { data: targetUser, error: fetchError } = await admin
    .from("profiles")
    .select("id, dealer_id, role, email")
    .eq("id", params.id)
    .single();

  if (fetchError || !targetUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { error: updateError } = await admin.auth.admin.updateUserById(
    claims.sub,
    {
      app_metadata: {
        role: claims.role,
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
    message: "Impersonation active. Refresh your session token to pick up new claims.",
  });
}
