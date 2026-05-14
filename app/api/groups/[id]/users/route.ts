import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { sendMandrillEmail } from "@/lib/mandrill";
import type { ProfileRow } from "@/lib/db";

type Params = { params: { id: string } };

const GROUP_ROLES = new Set(["group_admin", "group_user"]);

/**
 * GET /api/groups/[id]/users
 * Returns all profiles belonging to this group (group_admin + group_user).
 * super_admin: any group. group_admin: own group only.
 */
export async function GET(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (claims.role !== "super_admin" && claims.role !== "group_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (claims.role === "group_admin" && params.id !== claims.group_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();
  const { data, error: dbError } = await admin
    .from("profiles")
    .select("id, email, full_name, role, active, last_login, created_at")
    .eq("group_id", params.id)
    .in("role", ["group_admin", "group_user"])
    .order("full_name");

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }

  // profiles.last_login is a custom column the platform never wired into the
  // sign-in path, so it always reads NULL. Supabase Auth maintains
  // auth.users.last_sign_in_at automatically — read it directly via the
  // admin schema and merge it in.
  const ids = (data ?? []).map(r => r.id as string);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: authRows } = ids.length > 0
    ? await (admin as any)
        .schema("auth")
        .from("users")
        .select("id, last_sign_in_at")
        .in("id", ids) as { data: Array<{ id: string; last_sign_in_at: string | null }> | null }
    : { data: [] as Array<{ id: string; last_sign_in_at: string | null }> };
  const lastSignInById = new Map<string, string | null>();
  for (const r of authRows ?? []) lastSignInById.set(r.id, r.last_sign_in_at ?? null);

  const enriched = (data ?? []).map(r => ({
    ...r,
    last_sign_in_at: lastSignInById.get(r.id as string) ?? null,
  }));

  return NextResponse.json({ data: enriched });
}

/**
 * POST /api/groups/[id]/users
 * Invite a new group user (group_admin or group_user).
 * Body: { firstName, lastName, email, role }
 * Creates an invitation record and sends an email.
 */
export async function POST(
  req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (claims.role !== "super_admin" && claims.role !== "group_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (claims.role === "group_admin" && params.id !== claims.group_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { firstName?: string; lastName?: string; email?: string; role?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { firstName, lastName, email, role } = body;
  if (!firstName?.trim()) return NextResponse.json({ error: "First name required" }, { status: 400 });
  if (!lastName?.trim())  return NextResponse.json({ error: "Last name required" }, { status: 400 });
  if (!email?.trim())     return NextResponse.json({ error: "Email required" }, { status: 400 });
  if (!role || !GROUP_ROLES.has(role)) {
    return NextResponse.json({ error: "Role must be group_admin or group_user" }, { status: 400 });
  }

  // group_admin cannot invite another group_admin if they are not super_admin
  if (claims.role === "group_admin" && role === "group_admin") {
    // Allow: group_admin can invite other group_admins within their group
  }

  const admin = createAdminSupabaseClient();

  // Get group name for email
  const { data: group } = await admin
    .from("groups")
    .select("name")
    .eq("id", params.id)
    .maybeSingle<{ name: string }>();

  // Check if email already registered
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existingUsers } = await (admin as any)
    .schema("auth")
    .from("users")
    .select("id")
    .eq("email", email.trim().toLowerCase())
    .limit(1) as { data: { id: string }[] | null };

  if (existingUsers && existingUsers.length > 0) {
    return NextResponse.json({
      error: "This email is already registered.",
    }, { status: 409 });
  }

  // Create invitation with group_id (no dealer_id)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: inv, error: invErr } = await (admin as any)
    .from("invitations")
    .upsert({
      email: email.trim().toLowerCase(),
      first_name: firstName.trim(),
      last_name: lastName.trim(),
      role,
      group_id: params.id,
      dealer_id: null,
      invited_by: claims.sub,
      accepted_at: null,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    }, { onConflict: "email,group_id", ignoreDuplicates: false })
    .select("token")
    .single() as { data: { token: string } | null; error: { message: string } | null };

  if (invErr || !inv) {
    return NextResponse.json({ error: invErr?.message ?? "Failed to create invitation" }, { status: 500 });
  }

  const groupName = group?.name ?? "your group";
  const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? "https://app.dealeraddendums.com"}/signup?invite=${inv.token}`;
  const fullName = `${firstName.trim()} ${lastName.trim()}`;

  try {
    await sendMandrillEmail({
      subject: `You've been invited to join ${groupName} on DA Platform`,
      from_email: "noreply@dealeraddendums.com",
      from_name: "DealerAddendums",
      to: [{ email: email.trim(), name: fullName, type: "to" }],
      html: `
<div style="font-family: Roboto, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 32px 24px; color: #333;">
  <div style="margin-bottom: 24px;">
    <img src="https://new-infobox-images.s3.us-east-1.amazonaws.com/da-logo.png" alt="DA Platform" width="40" height="40" style="border-radius: 50%;" />
  </div>
  <h2 style="font-size: 20px; font-weight: 600; margin: 0 0 8px;">You're invited to DA Platform</h2>
  <p style="margin: 0 0 16px; color: #55595c;">Hi ${firstName.trim()},</p>
  <p style="margin: 0 0 16px; color: #55595c;">
    You've been invited to join <strong>${groupName}</strong> on DealerAddendums Platform
    as a ${role === "group_admin" ? "Group Admin" : "Group User"}.
    Click the button below to set your password and get started.
  </p>
  <a href="${inviteUrl}"
     style="display: inline-block; background: #1976d2; color: #fff; text-decoration: none;
            padding: 10px 24px; border-radius: 4px; font-weight: 600; font-size: 14px; margin: 8px 0 24px;">
    Accept Invitation
  </a>
  <p style="color: #78828c; font-size: 12px; margin: 0;">
    This invitation expires in 7 days. If you did not expect this email, you can safely ignore it.
  </p>
</div>
`,
    });
  } catch (emailErr) {
    console.error("[group-invite] Mandrill send failed:", emailErr instanceof Error ? emailErr.message : emailErr);
  }

  return NextResponse.json({ ok: true });
}
