import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { sendMandrillEmail } from "@/lib/mandrill";
import { buildInviteEmail } from "@/lib/invite-email";
import { generateSetupCode, hashSetupCode } from "@/lib/invite-code";

const DEALER_ROLES = new Set(["dealer_admin", "dealer_user", "dealer_restricted"]);

/**
 * GET /api/invite?token=
 * Validate an invitation token. No auth required.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) return NextResponse.json({ error: "token required" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: inv } = await (admin as any)
    .from("invitations")
    .select("id, email, first_name, last_name, role, dealer_name, group_id, expires_at, accepted_at")
    .eq("token", token)
    .maybeSingle() as { data: {
      id: string; email: string; first_name: string; last_name: string;
      role: string; dealer_name: string | null; group_id: string | null;
      expires_at: string; accepted_at: string | null;
    } | null };

  if (!inv) return NextResponse.json({ error: "Invalid invitation" }, { status: 404 });
  if (inv.accepted_at) return NextResponse.json({ error: "Invitation already accepted" }, { status: 410 });
  if (new Date(inv.expires_at) < new Date()) return NextResponse.json({ error: "Invitation expired" }, { status: 410 });

  // Org name for the "Invited to … as …" badge. Group invites have no
  // dealer_name, so resolve the group's name instead.
  let orgName = inv.dealer_name;
  if (!orgName && inv.group_id) {
    const { data: g } = await admin.from("groups").select("name").eq("id", inv.group_id).maybeSingle<{ name: string }>();
    orgName = g?.name ?? null;
  }

  // Wrap in { data: ... } — the signup page reads json.data.* and treats
  // an undefined data field as an invalid invitation. Returning flat
  // top-level fields breaks the accept flow on the client side.
  return NextResponse.json({
    data: {
      email: inv.email,
      firstName: inv.first_name,
      lastName: inv.last_name,
      role: inv.role,
      dealerName: orgName ?? "your organization",
    },
  });
}

/**
 * POST /api/invite
 * Create an invitation and send an email via Mandrill.
 * Body: { firstName, lastName, email, role }
 * Dealer is derived from auth claims (active_dealer_id for group_admin, dealer_id for dealer_admin).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  // group_admin OR group_user (regional manager) switched into a dealer may
  // invite that dealer's staff (full dealer parity); role is constrained to
  // DEALER_ROLES below, so neither can mint a group-level user here.
  const isGroupAdminContext = (claims.role === "group_admin" || claims.role === "group_user") && !!claims.active_dealer_id;
  const isDealerAdmin = claims.role === "dealer_admin";
  const isSuperAdmin = claims.role === "super_admin";

  if (!isSuperAdmin && !isDealerAdmin && !isGroupAdminContext) {
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
  if (!role || !DEALER_ROLES.has(role)) return NextResponse.json({ error: "Invalid role" }, { status: 400 });

  const admin = createAdminSupabaseClient();

  // Resolve the target dealer UUID
  let dealerUuid: string | null = null;
  let dealerName: string | null = null;

  if (isGroupAdminContext) {
    dealerUuid = claims.active_dealer_id;
  } else if (isDealerAdmin && claims.dealer_id) {
    const { data: d } = await admin.from("dealers").select("id, name").eq("dealer_id", claims.dealer_id).maybeSingle<{ id: string; name: string }>();
    dealerUuid = d?.id ?? null;
    dealerName = d?.name ?? null;
  } else if (isSuperAdmin) {
    // super_admin invites through the same modal as everyone else, resolving the
    // TARGET dealer from ghost context (the canonical dealer-context the Users
    // page itself uses — GET /api/users scopes ghost mode the same way). The
    // ghost token carries both the dealer UUID and text id; prefer the UUID,
    // fall back to a text-id lookup for tokens that only carry dealer_text_id.
    if (claims.is_ghost && claims.ghost_dealer_uuid) {
      dealerUuid = claims.ghost_dealer_uuid;
    } else if (claims.is_ghost && claims.dealer_id) {
      const { data: d } = await admin.from("dealers").select("id, name").eq("dealer_id", claims.dealer_id).maybeSingle<{ id: string; name: string }>();
      dealerUuid = d?.id ?? null;
      dealerName = d?.name ?? null;
    } else {
      return NextResponse.json({
        error: "No dealer selected. Open the dealer's Users page via Login / Ghost Mode on their profile, then send the invite from there.",
      }, { status: 400 });
    }
  }

  if (!dealerUuid) return NextResponse.json({ error: "No active dealer context" }, { status: 400 });

  if (!dealerName) {
    const { data: d } = await admin.from("dealers").select("name").eq("id", dealerUuid).maybeSingle<{ name: string }>();
    dealerName = d?.name ?? null;
  }

  // Check if already registered. (auth schema isn't on the data API — the old
  // admin.schema("auth") check silently returned null; profiles is the reliable
  // case-insensitive existence signal.)
  const { data: existingProfile } = await admin
    .from("profiles")
    .select("id")
    .ilike("email", email.trim().toLowerCase())
    .maybeSingle<{ id: string }>();

  if (existingProfile) {
    return NextResponse.json({
      error: "This email is already registered. Contact support to add access to multiple dealerships.",
    }, { status: 409 });
  }

  // One-time setup code — emailed in plaintext, stored only as a hash. The
  // invitation is consumed (account finalized) only when the invitee submits
  // this code, so a link-scanner pre-fetching the URL can't consume it.
  const setupCode = generateSetupCode();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  // Create invitation (upsert: same email+dealer re-sends invite)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: inv, error: invErr } = await (admin as any)
    .from("invitations")
    .upsert({
      email: email.trim().toLowerCase(),
      first_name: firstName.trim(),
      last_name: lastName.trim(),
      role,
      dealer_id: dealerUuid,
      dealer_name: dealerName,
      invited_by: claims.sub,
      accepted_at: null,
      expires_at: expiresAt,
      setup_code_hash: hashSetupCode(setupCode),
      setup_code_expires_at: expiresAt,
    }, { onConflict: "email,dealer_id", ignoreDuplicates: false })
    .select("token")
    .single() as { data: { token: string } | null; error: { message: string } | null };

  if (invErr || !inv) {
    return NextResponse.json({ error: invErr?.message ?? "Failed to create invitation" }, { status: 500 });
  }

  const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? "https://app.dealeraddendums.com"}/signup?invite=${inv.token}`;
  const fullName = `${firstName.trim()} ${lastName.trim()}`;
  const roleLabel = role === "dealer_admin" ? "Dealer Admin" : role === "dealer_restricted" ? "Dealer Restricted" : "Dealer User";

  let emailSent = true;
  let warning: string | undefined;
  try {
    await sendMandrillEmail({
      subject: `You've been invited to join ${dealerName ?? "your dealership"} on DA Platform`,
      from_email: "noreply@dealeraddendums.com",
      from_name: "DealerAddendums",
      to: [{ email: email.trim(), name: fullName, type: "to" }],
      html: buildInviteEmail({ firstName: firstName.trim(), orgName: dealerName ?? "your dealership", roleLabel, inviteUrl, setupCode }),
    });
  } catch (emailErr) {
    emailSent = false;
    warning = `Invitation created, but the email could not be delivered: ${emailErr instanceof Error ? emailErr.message : "send failed"}`;
    console.error("[invite] Mandrill send failed:", emailErr instanceof Error ? emailErr.message : emailErr);
  }

  return NextResponse.json({ ok: true, emailSent, ...(warning ? { warning } : {}) });
}
