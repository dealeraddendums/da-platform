import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const admin = createAdminSupabaseClient();

  // Fetch all super_admin + group_admin profiles
  const { data: profiles, error: profilesErr } = await admin
    .from("profiles")
    .select("id, email, full_name, role, created_at")
    .in("role", ["super_admin", "group_admin"])
    .order("role")
    .order("full_name");

  if (profilesErr) return NextResponse.json({ error: profilesErr.message }, { status: 500 });

  const userIds = (profiles ?? []).map(p => p.id);

  const { data: staffRows } = await admin
    .from("staff_profiles")
    .select("*")
    .in("user_id", userIds);

  const staffMap = new Map((staffRows ?? []).map(s => [s.user_id, s]));

  const result = (profiles ?? []).map(p => ({
    ...p,
    staffProfile: staffMap.get(p.id) ?? null,
  }));

  return NextResponse.json({ staff: result });
}
