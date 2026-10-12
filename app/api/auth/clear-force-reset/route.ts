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
  // getUser() verifies the token with GoTrue; getSession() would trust whatever
  // the cookie says about who this is.
  const { data: { user }, error: userErr } = await supabase.auth.getUser();

  if (userErr || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const admin = createAdminSupabaseClient();

  // Merge into the user's CURRENT app_metadata (not the copy in the token,
  // which may be stale) so no other server-set field is overwritten.
  const { data: fresh } = await admin.auth.admin.getUserById(user.id);
  const { error: authErr } = await admin.auth.admin.updateUserById(user.id, {
    app_metadata: {
      ...(fresh?.user?.app_metadata ?? user.app_metadata),
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
    .eq("id", user.id);

  return NextResponse.json({ ok: true });
}
