import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { sendMandrillEmail } from "@/lib/mandrill";
import { buildInviteEmail } from "@/lib/invite-email";
import { lastSignInByEmail } from "@/lib/last-sign-in";
import { generateSetupCode, hashSetupCode } from "@/lib/invite-code";
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

  // Supabase Auth maintains auth.users.last_sign_in_at, but the `auth` schema
  // isn't exposed to PostgREST (admin.schema("auth") returns nothing), and
  // matching by profiles.id misses ETL/legacy profiles whose id != auth id.
  // Resolve via the GoTrue admin API, keyed by EMAIL.
  const lastSignIn = await lastSignInByEmail();
  const enriched = (data ?? []).map(r => ({
    ...r,
    last_sign_in_at: lastSignIn.get((r.email ?? "").toLowerCase()) ?? null,
  }));

  // Pending invitations — created but not yet accepted, not expired. Without
  // this an invitee is invisible (not a profile yet) until they accept.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: pending } = await (admin as any)
    .from("invitations")
    .select("id, email, first_name, last_name, role, created_at, expires_at")
    .eq("group_id", params.id)
    .is("accepted_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });

  return NextResponse.json({ data: enriched, pendingInvitations: pending ?? [] });
}

/**
 * POST /api/groups/[id]/users
 * Invite a new group user (group_admin or group_user).
 * Body: { firstName, lastName, email, role, tag_ids? }
 * tag_ids (group_user invites only, 2026-08-12): store-tag scope assigned at
 * invite time — carried on invitations.scope_tag_ids (migration 141) and
 * applied as user_tags rows by /api/invite/accept, so the Regional Manager
 * lands with their stores already scoped.
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

  let body: { firstName?: string; lastName?: string; email?: string; role?: string; tag_ids?: string[] };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { firstName, lastName, email, role } = body;
  const tagIds = role === "group_user" && Array.isArray(body.tag_ids)
    ? body.tag_ids.filter((t): t is string => typeof t === "string" && t.length > 0)
    : [];
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

  // Check if already registered. NOTE: the auth schema isn't exposed to the data
  // API (admin.schema("auth") returns a 406, silently null), so the old check
  // never detected anyone. A profile existing for the email is the reliable,
  // case-insensitive signal that they already have an account.
  const { data: existingProfile } = await admin
    .from("profiles")
    .select("id")
    .ilike("email", email.trim().toLowerCase())
    .maybeSingle<{ id: string }>();

  if (existingProfile) {
    return NextResponse.json({
      error: "This email is already registered.",
    }, { status: 409 });
  }

  // Invite-time tag scope: every tag must be IN USE on this group's dealers
  // (same restriction as PUT /api/users/[id]/tags for group_admin callers) —
  // a foreign/unused tag id is refused rather than silently scoping the
  // manager to dealers outside this group.
  if (tagIds.length) {
    const { data: groupDealers } = await admin
      .from("dealers").select("id").eq("group_id", params.id);
    const dealerIds = (groupDealers ?? []).map((d) => d.id as string);
    const usable = new Set<string>();
    if (dealerIds.length) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: dts } = await (admin as any)
        .from("dealer_tags").select("tag_id").in("dealer_id", dealerIds).in("tag_id", tagIds);
      for (const r of (dts ?? []) as Array<{ tag_id: string }>) usable.add(r.tag_id);
    }
    const foreign = tagIds.filter((t) => !usable.has(t));
    if (foreign.length) {
      return NextResponse.json({ error: "One or more store tags are not in use on this group's dealers" }, { status: 400 });
    }
  }

  // One-time setup code — emailed in plaintext, stored only as a hash. The
  // invitation is consumed only when the invitee submits this code, so a
  // link-scanner pre-fetching the URL can't consume it.
  const setupCode = generateSetupCode();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

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
      expires_at: expiresAt,
      setup_code_hash: hashSetupCode(setupCode),
      setup_code_expires_at: expiresAt,
      // Applied as user_tags by /api/invite/accept (migration 141).
      scope_tag_ids: tagIds.length ? tagIds : null,
    }, { onConflict: "email,group_id", ignoreDuplicates: false })
    .select("token")
    .single() as { data: { token: string } | null; error: { message: string } | null };

  if (invErr || !inv) {
    return NextResponse.json({ error: invErr?.message ?? "Failed to create invitation" }, { status: 500 });
  }

  const groupName = group?.name ?? "your group";
  const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? "https://app.dealeraddendums.com"}/signup?invite=${inv.token}`;
  const fullName = `${firstName.trim()} ${lastName.trim()}`;

  // Don't swallow send failures — surface emailSent + a warning so the UI can
  // tell the operator the invite was created but the email didn't go out.
  // sendMandrillEmail now throws on a rejected/invalid recipient too.
  let emailSent = true;
  let warning: string | undefined;
  try {
    await sendMandrillEmail({
      subject: `You've been invited to join ${groupName} on DA Platform`,
      from_email: "noreply@dealeraddendums.com",
      from_name: "DealerAddendums",
      to: [{ email: email.trim(), name: fullName, type: "to" }],
      html: buildInviteEmail({
        firstName: firstName.trim(),
        orgName: groupName,
        roleLabel: role === "group_admin" ? "Group Admin" : "Group User",
        inviteUrl,
        setupCode,
      }),
    });
  } catch (emailErr) {
    emailSent = false;
    warning = `Invitation created, but the email could not be delivered: ${emailErr instanceof Error ? emailErr.message : "send failed"}`;
    console.error("[group-invite] Mandrill send failed:", emailErr instanceof Error ? emailErr.message : emailErr);
  }

  return NextResponse.json({ ok: true, emailSent, ...(warning ? { warning } : {}) });
}
