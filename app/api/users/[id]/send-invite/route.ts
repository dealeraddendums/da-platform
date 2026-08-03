import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient, fireWrite } from "@/lib/db";
import { sendMandrillEmail } from "@/lib/mandrill";
import { buildAccountReadyEmail, buildPasswordResetEmail } from "@/lib/invite-email";
import { generateSetupCode, hashSetupCode } from "@/lib/invite-code";
import { lastSignInByEmail } from "@/lib/last-sign-in";

const ROLE_LABELS: Record<string, string> = {
  super_admin:       "Super Admin",
  group_admin:       "Group Admin",
  group_user:        "Regional Manager",
  dealer_admin:      "Dealer Admin",
  dealer_user:       "Dealer User",
  dealer_restricted: "Dealer Restricted",
};

/**
 * POST /api/users/[id]/send-invite  (super_admin only)
 *
 * Send an existing user their credentials: a scanner-proof 8-digit setup code
 * + inert /signup?invite= link (same machinery as staff invites — the accept
 * path updates an existing auth user in place, so this doubles as a password
 * reset). Copy varies: never-signed-in users get "your account is ready",
 * previously-signed-in users get "reset your password".
 *
 * The invitation row is built from the target's CURRENT profile (role,
 * dealer, group), so acceptance rewrites the profile with the same values.
 * Re-sending replaces the old setup code (old code dead, same token/link).
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();

  const { data: target } = await admin
    .from("profiles")
    .select("id, email, full_name, role, dealer_id, group_id")
    .eq("id", params.id)
    .maybeSingle<{
      id: string; email: string | null; full_name: string | null;
      role: string; dealer_id: string | null; group_id: string | null;
    }>();

  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });
  if (!target.email) return NextResponse.json({ error: "User has no email address" }, { status: 400 });

  const email = target.email.trim();
  const nameParts = (target.full_name ?? "").trim().split(/\s+/).filter(Boolean);
  const firstName = nameParts[0] ?? email.split("@")[0];
  const lastName  = nameParts.slice(1).join(" "); // "" for single-name users (column is NOT NULL, "" is fine)

  // Resolve org scope from the current profile. Staff/super_admin users have
  // neither — the invitation row carries NULL dealer_id + NULL group_id and
  // /api/invite/accept takes its staff branch.
  let dealerUuid: string | null = null;
  let orgName: string | null = null;
  if (target.dealer_id) {
    const { data: dealer } = await admin
      .from("dealers")
      .select("id, name")
      .eq("dealer_id", target.dealer_id)
      .maybeSingle<{ id: string; name: string }>();
    if (!dealer) {
      return NextResponse.json({ error: `Dealer "${target.dealer_id}" not found for this user` }, { status: 400 });
    }
    dealerUuid = dealer.id;
    orgName = dealer.name;
  } else if (target.group_id) {
    const { data: group } = await admin
      .from("groups")
      .select("name")
      .eq("id", target.group_id)
      .maybeSingle<{ name: string }>();
    orgName = group?.name ?? null;
  }

  // Invite vs reset: has this user ever signed in?
  const lastSignIn = await lastSignInByEmail();
  const hasSignedIn = !!lastSignIn.get(email.toLowerCase());
  const mode: "invite" | "reset" = hasSignedIn ? "reset" : "invite";

  const setupCode = generateSetupCode();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  // Find-then-write instead of upsert: the (email, dealer_id) / (email,
  // group_id) unique indexes never fire on the staff scope (both NULL), and a
  // consumed (accepted) row would block a plain insert on the dealer/group
  // scopes — so match any existing row for this email+scope and refresh it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let existingQ = (admin as any)
    .from("invitations")
    .select("id, token")
    .eq("email", email);
  if (dealerUuid)           existingQ = existingQ.eq("dealer_id", dealerUuid);
  else if (target.group_id) existingQ = existingQ.eq("group_id", target.group_id);
  else                      existingQ = existingQ.is("dealer_id", null).is("group_id", null);
  const { data: existing } = await existingQ
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle() as { data: { id: string; token: string } | null };

  const invFields = {
    email,
    first_name: firstName,
    last_name:  lastName,
    role:       target.role,
    dealer_id:  dealerUuid,
    group_id:   dealerUuid ? null : (target.group_id ?? null),
    dealer_name: orgName ?? "DealerAddendums",
    invited_by: claims.sub,
    purpose:    "user",
    accepted_at: null,
    created_at: new Date().toISOString(), // "last sent" — drives the invited-hint in the UI
    expires_at: expiresAt,
    setup_code_hash: hashSetupCode(setupCode),
    setup_code_expires_at: expiresAt,
  };

  let token: string | null = null;
  if (existing) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: updErr } = await (admin as any)
      .from("invitations").update(invFields).eq("id", existing.id);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    token = existing.token;
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: inserted, error: insErr } = await (admin as any)
      .from("invitations").insert(invFields).select("token").single() as
      { data: { token: string } | null; error: { message: string } | null };
    if (insErr || !inserted) {
      return NextResponse.json({ error: insErr?.message ?? "Failed to create invitation" }, { status: 500 });
    }
    token = inserted.token;
  }

  const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? "https://app.dealeraddendums.com"}/signup?invite=${token}`;
  const roleLabel = ROLE_LABELS[target.role] ?? target.role;

  try {
    await sendMandrillEmail({
      subject: mode === "invite"
        ? "Your DealerAddendums 5.0 account is ready"
        : "Reset your DealerAddendums 5.0 password",
      from_email: "noreply@dealeraddendums.com",
      from_name: "DealerAddendums",
      to: [{ email, name: target.full_name ?? email, type: "to" }],
      html: mode === "invite"
        ? buildAccountReadyEmail({ firstName, email, roleLabel, orgName, inviteUrl, setupCode })
        : buildPasswordResetEmail({ firstName, email, inviteUrl, setupCode }),
    });
  } catch (emailErr) {
    const detail = emailErr instanceof Error ? emailErr.message : "send failed";
    console.error("[send-invite] Mandrill send failed:", detail);
    return NextResponse.json({ error: `Email could not be delivered: ${detail}` }, { status: 502 });
  }

  fireWrite(admin.from("admin_audit").insert({
    admin_user_id: claims.sub,
    action: mode === "invite" ? "send_user_invite" : "send_user_reset_email",
    target_dealer_id: target.dealer_id,
    metadata: { target_user_id: target.id, email, role: target.role, mode },
  }), "admin_audit");

  return NextResponse.json({ ok: true, mode, email });
}
