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

  if (!claims.impersonating_dealer_id) {
    return NextResponse.json(
      { error: "No active impersonation session" },
      { status: 400 }
    );
  }

  const admin = createAdminSupabaseClient();

  // Remove impersonation fields from app_metadata
  const { error: updateError } = await admin.auth.admin.updateUserById(
    claims.sub,
    {
      app_metadata: {
        user_type: claims.user_type,
        dealer_id: claims.dealer_id,
        // Explicitly clear impersonation fields by omitting them
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
