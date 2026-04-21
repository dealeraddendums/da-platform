import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";

/**
 * POST /api/auth/clear-force-reset
 * Clears force_password_reset from the current user's app_metadata and profile.
 * Called after successful password change on /reset-password.
 */
export async function POST(): Promise<NextResponse> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();

  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const admin = createAdminSupabaseClient();

  // Clear flag in auth.users app_metadata
  const { error: authErr } = await admin.auth.admin.updateUserById(session.user.id, {
    app_metadata: {
      ...session.user.app_metadata,
      force_password_reset: false,
    },
  });

  if (authErr) {
    return NextResponse.json({ error: authErr.message }, { status: 500 });
  }

  // Clear flag in profiles table
  await admin
    .from("profiles")
    .update({ force_password_reset: false, last_activity: new Date().toISOString() } as never)
    .eq("id", session.user.id);

  return NextResponse.json({ ok: true });
}
