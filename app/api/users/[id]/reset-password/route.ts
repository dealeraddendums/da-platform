import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

type Params = { params: { id: string } };

/**
 * POST /api/users/[id]/reset-password
 * Trigger a Supabase password-reset email for a sub-user.
 */
export async function POST(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const dealerId = claims.dealer_id;
  const admin = createAdminSupabaseClient();

  const { data: targetUser, error: fetchError } = await admin
    .from("profiles")
    .select("id, email, dealer_id")
    .eq("id", params.id)
    .eq("dealer_id", dealerId ?? "")
    .single();

  if (fetchError || !targetUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
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

  return NextResponse.json({ success: true, message: "Password reset email sent" });
}
