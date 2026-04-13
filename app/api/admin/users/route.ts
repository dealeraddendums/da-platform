import { NextRequest, NextResponse } from "next/server";
import { requireRootAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { UserRole } from "@/lib/db";

const VALID_ROLES: UserRole[] = [
  "root_admin",
  "reseller_admin",
  "reseller_user",
  "group_admin",
  "group_user",
  "group_user_restricted",
  "dealer",
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
  const { error } = await requireRootAdmin();
  if (error) return error;

  const { searchParams } = req.nextUrl;
  const filterDealerId = searchParams.get("dealer_id");
  const rawUserType = searchParams.get("user_type");
  const filterUserType: UserRole | null =
    rawUserType && isUserRole(rawUserType) ? rawUserType : null;

  const admin = createAdminSupabaseClient();

  let query = admin
    .from("users")
    .select("id, dealer_id, user_type, email, name, created_at")
    .order("created_at", { ascending: false });

  if (filterDealerId) query = query.eq("dealer_id", filterDealerId);
  if (filterUserType) query = query.eq("user_type", filterUserType);

  const { data, error: dbError } = await query;

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }

  return NextResponse.json({ users: data });
}
