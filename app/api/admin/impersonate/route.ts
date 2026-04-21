import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

/**
 * POST /api/admin/impersonate
 * super_admin only. Finds the dealer_admin user for a given dealer_id,
 * generates a magic-link token they can exchange for a real session client-side,
 * and logs the event to admin_audit.
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

  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: targetProfile.email,
  });

  if (linkError || !linkData) {
    return NextResponse.json({ error: linkError?.message ?? "Failed to generate link" }, { status: 500 });
  }

  // Log impersonation event — fire and forget, don't block on failure
  void admin.from("admin_audit").insert({
    admin_user_id: claims.sub,
    action: "impersonate",
    target_dealer_id: dealer_id,
    metadata: { dealer_name: dealer.name, target_email: targetProfile.email },
  });

  return NextResponse.json({
    token_hash: linkData.properties.hashed_token,
    dealer_name: dealer.name,
    dealer_id: dealer.dealer_id,
  });
}
