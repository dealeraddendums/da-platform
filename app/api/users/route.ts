import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createServerSupabaseClient, createAdminSupabaseClient } from "@/lib/db";
import type { UserRole } from "@/lib/db";

/**
 * GET /api/users
 * List all users belonging to the authenticated dealer.
 * RLS policy on the users table enforces dealer isolation automatically.
 */
export async function GET(): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const supabase = createServerSupabaseClient();
  const dealerId = claims.impersonating_dealer_id ?? claims.dealer_id;

  const { data, error: dbError } = await supabase
    .from("users")
    .select("id, dealer_id, user_type, email, name, created_at")
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

  let body: { email?: string; name?: string; user_type?: UserRole };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { email, name, user_type } = body;
  if (!email || !name) {
    return NextResponse.json(
      { error: "email and name are required" },
      { status: 400 }
    );
  }

  const dealerId = claims.impersonating_dealer_id ?? claims.dealer_id;

  // Use service-role client to create auth user + profile atomically
  const admin = createAdminSupabaseClient();

  // 1. Create Supabase Auth user with app_metadata carrying role/dealer_id
  const { data: authData, error: authError } = await admin.auth.admin.createUser(
    {
      email,
      email_confirm: true,
      app_metadata: {
        user_type: user_type ?? "dealer",
        dealer_id: dealerId,
      },
    }
  );

  if (authError) {
    return NextResponse.json({ error: authError.message }, { status: 400 });
  }

  // 2. Insert matching row in public.users
  const { data: profile, error: profileError } = await admin
    .from("users")
    .insert({
      id: authData.user.id,
      dealer_id: dealerId,
      user_type: user_type ?? "dealer",
      email,
      name,
    })
    .select()
    .single();

  if (profileError) {
    // Roll back auth user
    await admin.auth.admin.deleteUser(authData.user.id);
    return NextResponse.json({ error: profileError.message }, { status: 500 });
  }

  return NextResponse.json({ user: profile }, { status: 201 });
}
