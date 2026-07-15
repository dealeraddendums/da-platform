import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient, fireWrite } from "@/lib/db";

/**
 * POST /api/admin/ghost/exit
 * Clears the da_ghost_token cookie to exit ghost mode.
 * The super_admin's session is unchanged throughout — ghost mode never swaps it.
 */
export async function POST(): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  // Log — fire and forget
  const admin = createAdminSupabaseClient();
  fireWrite(admin.from("admin_audit").insert({
    admin_user_id: claims.sub,
    action: "ghost_mode_exit",
    metadata: {},
  }), "admin_audit");

  const res = NextResponse.json({ ok: true });
  res.cookies.set("da_ghost_token", "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });

  return res;
}
