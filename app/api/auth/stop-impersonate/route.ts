import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

/**
 * POST /api/auth/stop-impersonate
 * End an active impersonation session and restore the real admin identity.
 */
export async function POST(): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient();

  const { error: updateError } = await admin.auth.admin.updateUserById(
    claims.sub,
    {
      app_metadata: {
        role: claims.role,
        dealer_id: claims.dealer_id,
        impersonating_dealer_id: null,
        impersonating_user_id: null,
        real_user_id: null,
      },
    }
  );

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    message: "Impersonation ended. Refresh your session token.",
  });
}
