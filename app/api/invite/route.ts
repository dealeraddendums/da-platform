import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { sendMandrillEmail } from "@/lib/mandrill";

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
    .select("id, email, first_name, last_name, role, dealer_name, expires_at, accepted_at")
    .eq("token", token)
    .maybeSingle() as { data: {
      id: string; email: string; first_name: string; last_name: string;
      role: string; dealer_name: string | null; expires_at: string; accepted_at: string | null;
    } | null };

  if (!inv) return NextResponse.json({ error: "Invalid invitation" }, { status: 404 });
  if (inv.accepted_at) return NextResponse.json({ error: "Invitation already accepted" }, { status: 410 });
  if (new Date(inv.expires_at) < new Date()) return NextResponse.json({ error: "Invitation expired" }, { status: 410 });

  return NextResponse.json({
    email: inv.email,
    firstName: inv.first_name,
    lastName: inv.last_name,
    role: inv.role,
    dealerName: inv.dealer_name,
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

  const isGroupAdminContext = claims.role === "group_admin" && !!claims.active_dealer_id;
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
    return NextResponse.json({ error: "Super admins must use POST /api/users directly" }, { status: 400 });
  }

  if (!dealerUuid) return NextResponse.json({ error: "No active dealer context" }, { status: 400 });

  if (!dealerName) {
    const { data: d } = await admin.from("dealers").select("name").eq("id", dealerUuid).maybeSingle<{ name: string }>();
    dealerName = d?.name ?? null;
  }

  // Check if email already registered in Supabase Auth
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existingUsers } = await (admin as any)
    .schema("auth")
    .from("users")
    .select("id")
    .eq("email", email.trim().toLowerCase())
    .limit(1) as { data: { id: string }[] | null };

  if (existingUsers && existingUsers.length > 0) {
    return NextResponse.json({
      error: "This email is already registered. Contact support to add access to multiple dealerships.",
    }, { status: 409 });
  }

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
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    }, { onConflict: "email,dealer_id", ignoreDuplicates: false })
    .select("token")
    .single() as { data: { token: string } | null; error: { message: string } | null };

  if (invErr || !inv) {
    return NextResponse.json({ error: invErr?.message ?? "Failed to create invitation" }, { status: 500 });
  }

  const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? "https://app.dealeraddendums.com"}/signup?invite=${inv.token}`;
  const fullName = `${firstName.trim()} ${lastName.trim()}`;

  try {
    await sendMandrillEmail({
      subject: `You've been invited to join ${dealerName ?? "your dealership"} on DA Platform`,
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
    You've been invited to join <strong>${dealerName ?? "your dealership"}</strong> on DealerAddendums Platform.
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
    console.error("[invite] Mandrill send failed:", emailErr instanceof Error ? emailErr.message : emailErr);
    // Don't fail the request — the invitation record is created. User can resend.
  }

  return NextResponse.json({ ok: true });
}
