import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

/**
 * POST /api/admin/impersonate-group
 * super_admin only. Finds the group_admin user for a given group UUID,
 * exchanges a magic-link token server-side for a real access/refresh token pair.
 * Body: { group_id: string }  — Supabase groups.id UUID
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  let body: { group_id?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { group_id } = body;
  if (!group_id) return NextResponse.json({ error: "group_id required" }, { status: 400 });

  const admin = createAdminSupabaseClient();

  const { data: group } = await admin
    .from("groups")
    .select("id, name")
    .eq("id", group_id)
    .maybeSingle<{ id: string; name: string }>();

  if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 });

  // Deterministic target: oldest group_admin by created_at, then email — NOT an
  // arbitrary row order (which silently picked whoever the DB returned first).
  const { data: profileRows } = await admin
    .from("profiles")
    .select("id, email, role, created_at")
    .eq("group_id", group_id)
    .eq("role", "group_admin")
    .order("created_at", { ascending: true, nullsFirst: false })
    .order("email", { ascending: true });

  const targetProfile = (profileRows ?? [])[0] ?? null;
  if (!targetProfile) {
    return NextResponse.json(
      { error: "No group_admin user account exists for this group. Use ghost mode instead." },
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

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  const verifyRes = await fetch(`${supabaseUrl}/auth/v1/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: supabaseAnonKey },
    body: JSON.stringify({ token_hash: linkData.properties.hashed_token, type: "magiclink" }),
  });

  if (!verifyRes.ok) {
    const errText = await verifyRes.text().catch(() => "unknown");
    return NextResponse.json({ error: `Token exchange failed: ${errText}` }, { status: 500 });
  }

  const sessionData = (await verifyRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    error?: string;
    error_description?: string;
    msg?: string;
  };

  if (!sessionData.access_token || !sessionData.refresh_token) {
    return NextResponse.json(
      { error: sessionData.error_description ?? sessionData.msg ?? "No session returned" },
      { status: 500 }
    );
  }

  // Reset active-dealer to GROUP LEVEL on impersonation entry: clear the target
  // group_admin's persisted active_dealer_id so the impersonated session lands
  // at the group, not inside whatever member dealer that user last switched into
  // (the "Crown Nissan" bug). This is the same clear the "← Back to Group" action
  // performs; it's transient nav state, and group-level is the correct landing.
  await admin.from("profiles").update({ active_dealer_id: null }).eq("id", targetProfile.id);

  void admin.from("admin_audit").insert({
    admin_user_id: claims.sub,
    action: "impersonate_group",
    metadata: { group_name: group.name, group_id, target_email: targetProfile.email },
  });

  return NextResponse.json({
    access_token: sessionData.access_token,
    refresh_token: sessionData.refresh_token,
    group_name: group.name,
    group_id,
    // Surface who is being impersonated so the UI/banner can show it (no longer
    // an arbitrary, invisible choice).
    target_email: targetProfile.email,
  });
}
