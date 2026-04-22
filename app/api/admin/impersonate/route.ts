import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

/**
 * POST /api/admin/impersonate
 * super_admin only. Finds the dealer_admin user for a given dealer_id,
 * exchanges a magic-link token server-side for a real access/refresh token pair,
 * and logs the event to admin_audit.
 *
 * Client receives access_token + refresh_token and calls setSession() directly —
 * no client-side verifyOtp() needed, which avoids SSR cookie timing issues.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  let body: { dealer_id?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { dealer_id } = body;
  if (!dealer_id) return NextResponse.json({ error: "dealer_id required" }, { status: 400 });

  const admin = createAdminSupabaseClient();

  const { data: dealer } = await admin
    .from("dealers")
    .select("name, dealer_id")
    .eq("dealer_id", dealer_id)
    .single();

  if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });

  const { data: profileRows } = await admin
    .from("profiles")
    .select("id, email, role")
    .eq("dealer_id", dealer_id)
    .in("role", ["dealer_admin", "dealer_user", "dealer_restricted"]);

  const profiles = profileRows ?? [];
  const targetProfile =
    profiles.find((p) => p.role === "dealer_admin") ??
    profiles[0] ??
    null;

  if (!targetProfile) {
    return NextResponse.json(
      { error: "No dealer user account exists for this dealer. Use the New Dealer form to create one." },
      { status: 404 }
    );
  }

  // Generate a magic-link token via the admin API
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: targetProfile.email,
  });

  if (linkError || !linkData) {
    return NextResponse.json({ error: linkError?.message ?? "Failed to generate link" }, { status: 500 });
  }

  // Exchange the token server-side so the client gets real access/refresh tokens.
  // Using setSession() client-side is far more reliable than verifyOtp() for SSR apps.
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
    error?: string;
    error_description?: string;
    msg?: string;
  };

  if (!sessionData.access_token || !sessionData.refresh_token) {
    return NextResponse.json(
      { error: sessionData.error_description ?? sessionData.msg ?? "No session returned from token exchange" },
      { status: 500 }
    );
  }

  // Log impersonation event — fire and forget, don't block on failure
  void admin.from("admin_audit").insert({
    admin_user_id: claims.sub,
    action: "impersonate",
    target_dealer_id: dealer_id,
    metadata: { dealer_name: dealer.name, target_email: targetProfile.email },
  });

  return NextResponse.json({
    access_token: sessionData.access_token,
    refresh_token: sessionData.refresh_token,
    dealer_name: dealer.name,
    dealer_id: dealer.dealer_id,
  });
}
