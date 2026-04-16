import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { UserRole } from "@/lib/db";

const VALID_ROLES: UserRole[] = [
  "super_admin",
  "group_admin",
  "dealer_admin",
  "dealer_user",
];

function isUserRole(v: string): v is UserRole {
  return (VALID_ROLES as string[]).includes(v);
}

/**
 * GET /api/admin/users
 * List all users across the platform (root_admin only).
 * Supports optional ?dealer_id= and ?user_type= filters.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const { searchParams } = req.nextUrl;
  const filterDealerId = searchParams.get("dealer_id");
  const rawRole = searchParams.get("role");
  const filterUserType: UserRole | null =
    rawRole && isUserRole(rawRole) ? rawRole : null;

  const admin = createAdminSupabaseClient();

  let query = admin
    .from("profiles")
    .select("id, dealer_id, role, email, full_name, created_at")
    .order("created_at", { ascending: false });

  if (filterDealerId) query = query.eq("dealer_id", filterDealerId);
  if (filterUserType) query = query.eq("role", filterUserType);

  const { data, error: dbError } = await query;

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }

  return NextResponse.json({ users: data });
}
