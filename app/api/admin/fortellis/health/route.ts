import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { getHealth } from "@/lib/fortellis-sync";

/**
 * GET /api/admin/fortellis/health
 * Returns the Fortellis API availability state for the tab banner. super_admin only.
 */
export async function GET(): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;
  const admin = createAdminSupabaseClient();
  const health = await getHealth(admin);
  return NextResponse.json({ health });
}
