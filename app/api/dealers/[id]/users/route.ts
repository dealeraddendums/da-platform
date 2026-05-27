import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { sendMandrillEmail } from "@/lib/mandrill";

type Params = { params: { id: string } };

const DEALER_ROLES = new Set(["dealer_admin", "dealer_user", "dealer_restricted"]);

/**
 * GET /api/dealers/[id]/users
 * Returns all profiles whose `dealer_id` matches this dealer's
 * platform-side text id (the `dealer_id` column, not the UUID).
 *
 * Auth:
 *   - super_admin: any dealer
 *   - group_admin: dealers in their group only
 *   - dealer_admin: their own dealer only
 *   - dealer_user / dealer_restricted: 403
 */
export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient();

  // Look up the dealer once — we need both the text dealer_id (the
  // profiles.dealer_id FK convention) and the group_id for auth.
  const { data: dealerRow } = await admin
    .from("dealers")
    .select("id, dealer_id, group_id")
    .eq("id", params.id)
    .maybeSingle<{ id: string; dealer_id: string; group_id: string | null }>();
  if (!dealerRow) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });

  if (claims.role === "super_admin") {
    /* allowed */
  } else if (claims.role === "group_admin") {
    if (!dealerRow.group_id || dealerRow.group_id !== claims.group_id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else if (claims.role === "dealer_admin") {
    if (dealerRow.dealer_id !== claims.dealer_id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data, error: dbError } = await admin
    .from("profiles")
    .select("id, email, full_name, role, active, last_login, created_at")
    .eq("dealer_id", dealerRow.dealer_id)
    .in("role", ["dealer_admin", "dealer_user", "dealer_restricted"])
    .order("full_name");
  if (dbError) return NextResponse.json({ error: dbError.message }, { status: 500 });

  // Merge auth.users.last_sign_in_at (same pattern as the group users route).
  const ids = (data ?? []).map(r => r.id as string);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: authRows } = ids.length > 0
    ? await (admin as any)
        .schema("auth")
        .from("users")
        .select("id, last_sign_in_at")
        .in("id", ids) as { data: Array<{ id: string; last_sign_in_at: string | null }> | null }
    : { data: [] as Array<{ id: string; last_sign_in_at: string | null }> };
  const lastById = new Map<string, string | null>();
  for (const r of authRows ?? []) lastById.set(r.id, r.last_sign_in_at ?? null);

  const enriched = (data ?? []).map(r => ({
    ...r,
    last_sign_in_at: lastById.get(r.id as string) ?? null,
  }));

  return NextResponse.json({ data: enriched });
}

/**
 * POST /api/dealers/[id]/users
 * Invite a new dealer-side user (dealer_admin / dealer_user /
 * dealer_restricted). Creates a row in invitations + sends an email.
 *
 * Auth:
 *   - super_admin: any dealer
 *   - dealer_admin: their own dealer only
 *   - group_admin / dealer_user: 403 (group_admin can view but not invite
 *     on a specific dealer's user list per spec)
 */
export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (claims.role !== "super_admin" && claims.role !== "dealer_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { firstName?: string; lastName?: string; email?: string; role?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { firstName, lastName, email, role } = body;
  if (!firstName?.trim()) return NextResponse.json({ error: "First name required" }, { status: 400 });
  if (!lastName?.trim())  return NextResponse.json({ error: "Last name required" }, { status: 400 });
  if (!email?.trim())     return NextResponse.json({ error: "Email required" }, { status: 400 });
  if (!role || !DEALER_ROLES.has(role)) {
    return NextResponse.json({ error: "Role must be dealer_admin, dealer_user, or dealer_restricted" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  const { data: dealer } = await admin
    .from("dealers")
    .select("id, dealer_id, name")
    .eq("id", params.id)
    .maybeSingle<{ id: string; dealer_id: string; name: string }>();
  if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });

  if (claims.role === "dealer_admin" && dealer.dealer_id !== claims.dealer_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // dealer_admin cannot create another dealer_admin
  if (claims.role === "dealer_admin" && role === "dealer_admin") {
    return NextResponse.json({ error: "Only super_admin can invite another dealer_admin" }, { status: 403 });
  }

  // Reject if the email is already registered.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existing } = await (admin as any)
    .schema("auth")
    .from("users")
    .select("id")
    .eq("email", email.trim().toLowerCase())
    .limit(1) as { data: { id: string }[] | null };
  if (existing && existing.length > 0) {
    return NextResponse.json({ error: "This email is already registered." }, { status: 409 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: inv, error: invErr } = await (admin as any)
    .from("invitations")
    .upsert({
      email: email.trim().toLowerCase(),
      first_name: firstName.trim(),
      last_name: lastName.trim(),
      role,
      dealer_id: dealer.id, // invitations.dealer_id is uuid REFERENCES dealers(id), not the TEXT code
      group_id: null,
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
  const roleLabel = role === "dealer_admin" ? "Dealer Admin" : role === "dealer_restricted" ? "Dealer Restricted" : "Dealer User";

  try {
    await sendMandrillEmail({
      subject: `You've been invited to join ${dealer.name} on DA Platform`,
      from_email: "noreply@dealeraddendums.com",
      from_name: "DealerAddendums",
      to: [{ email: email.trim(), name: fullName, type: "to" }],
      html: `
<div style="font-family: Roboto, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 32px 24px; color: #333;">
  <div style="margin-bottom: 24px;">
    <img src="${process.env.NEXT_PUBLIC_APP_URL ?? "https://app.dealeraddendums.com"}/images/da-logo.png" alt="DA Platform" width="40" height="40" style="border-radius: 50%;" />
  </div>
  <h2 style="font-size: 20px; font-weight: 600; margin: 0 0 8px;">You're invited to DA Platform</h2>
  <p style="margin: 0 0 16px; color: #55595c;">Hi ${firstName.trim()},</p>
  <p style="margin: 0 0 16px; color: #55595c;">
    You've been invited to join <strong>${dealer.name}</strong> on DealerAddendums Platform
    as a ${roleLabel}.
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
</div>`,
    });
  } catch (mailErr) {
    // Invitation row exists — surface the email failure but return 200
    // so the operator knows the row was created.
    return NextResponse.json(
      { ok: true, warning: `Invitation saved but email failed: ${mailErr instanceof Error ? mailErr.message : String(mailErr)}` },
    );
  }

  return NextResponse.json({ ok: true });
}
