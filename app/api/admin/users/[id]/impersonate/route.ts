import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient, fireWrite } from "@/lib/db";

type Params = { params: { id: string } };

/**
 * POST /api/admin/users/[id]/impersonate
 * super_admin assumes the identity of a specific user by UUID.
 * Returns access_token + refresh_token (same shape as /api/admin/impersonate).
 * Client calls setSession() then redirects to /dashboard.
 */
export async function POST(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  const admin = createAdminSupabaseClient();

  const { data: targetProfile } = await admin
    .from("profiles")
    .select("id, email, full_name, role, dealer_id")
    .eq("id", params.id)
    .single<{ id: string; email: string; full_name: string | null; role: string; dealer_id: string | null }>();

  if (!targetProfile) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (targetProfile.role === "super_admin") {
    return NextResponse.json({ error: "Cannot impersonate another super admin" }, { status: 403 });
  }

  if (targetProfile.id === claims.sub) {
    return NextResponse.json({ error: "Cannot impersonate yourself" }, { status: 403 });
  }

  // Generate a magic-link token and exchange it server-side for real tokens.
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: targetProfile.email,
  });

  if (linkError || !linkData) {
    return NextResponse.json({ error: linkError?.message ?? "Failed to generate link" }, { status: 500 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  const verifyRes = await fetch(`${supabaseUrl}/auth/v1/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": supabaseAnonKey,
    },
    body: JSON.stringify({
      token_hash: linkData.properties.hashed_token,
      type: "magiclink",
    }),
  });

  if (!verifyRes.ok) {
    const errText = await verifyRes.text().catch(() => "unknown");
    return NextResponse.json({ error: `Token exchange failed: ${errText}` }, { status: 500 });
  }

  const sessionData = await verifyRes.json() as {
    access_token?: string;
    refresh_token?: string;
    error_description?: string;
    msg?: string;
  };

  if (!sessionData.access_token || !sessionData.refresh_token) {
    return NextResponse.json(
      { error: sessionData.error_description ?? sessionData.msg ?? "No session returned from token exchange" },
      { status: 500 }
    );
  }

  // Log impersonation event — fire and forget
  fireWrite(admin.from("admin_audit").insert({
    admin_user_id: claims.sub,
    action: "impersonate",
    target_dealer_id: targetProfile.dealer_id,
    metadata: { target_user_id: targetProfile.id, target_email: targetProfile.email, target_role: targetProfile.role },
  }), "admin_audit");

  return NextResponse.json({
    access_token: sessionData.access_token,
    refresh_token: sessionData.refresh_token,
    // Banner uses dealer_name for display; use user's name or email
    dealer_name: targetProfile.full_name ?? targetProfile.email,
    dealer_id: targetProfile.dealer_id ?? targetProfile.id,
  });
}
