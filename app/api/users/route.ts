import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createServerSupabaseClient, createAdminSupabaseClient } from "@/lib/db";
import type { UserRole } from "@/lib/db";

/**
 * GET /api/users
 * List all users belonging to the authenticated dealer.
 */
export async function GET(): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const supabase = createServerSupabaseClient();
  const dealerId = claims.dealer_id;

  if (!dealerId) {
    return NextResponse.json({ users: [] });
  }

  const { data, error: dbError } = await supabase
    .from("profiles")
    .select("id, dealer_id, role, email, full_name, created_at")
    .eq("dealer_id", dealerId)
    .order("created_at", { ascending: false });

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }

  return NextResponse.json({ users: data });
}

/**
 * POST /api/users
 * Create a sub-user for the authenticated dealer.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  let body: { email?: string; full_name?: string; role?: UserRole };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { email, full_name, role } = body;
  if (!email || !full_name) {
    return NextResponse.json(
      { error: "email and full_name are required" },
      { status: 400 }
    );
  }

  const dealerId = claims.dealer_id;

  const admin = createAdminSupabaseClient();

  const { data: authData, error: authError } = await admin.auth.admin.createUser(
    {
      email,
      email_confirm: true,
      app_metadata: {
        role: role ?? "dealer_user",
        dealer_id: dealerId,
      },
    }
  );

  if (authError) {
    return NextResponse.json({ error: authError.message }, { status: 400 });
  }

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .insert({
      id: authData.user.id,
      dealer_id: dealerId,
      role: role ?? "dealer_user",
      email,
      full_name,
    })
    .select()
    .single();

  if (profileError) {
    await admin.auth.admin.deleteUser(authData.user.id);
    return NextResponse.json({ error: profileError.message }, { status: 500 });
  }

  return NextResponse.json({ user: profile }, { status: 201 });
}
