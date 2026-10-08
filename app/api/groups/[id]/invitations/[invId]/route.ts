import { NextRequest, NextResponse } from "next/server";
import { requireAuth, type JwtClaims } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { sendMandrillEmail } from "@/lib/mandrill";
import { buildInviteEmail } from "@/lib/invite-email";
import { generateSetupCode, hashSetupCode } from "@/lib/invite-code";
import { issueInvitationLoginCode } from "@/lib/invite-login-code";

type Params = { params: { id: string; invId: string } };

/** POST body { action: "login-code" } — generate a setup code to read out
 *  instead of re-emailing (lib/invite-login-code.ts). Same guard as Resend. */
async function wantsLoginCode(req: NextRequest): Promise<boolean> {
  const b = await req.json().catch(() => null) as { action?: unknown } | null;
  return b?.action === "login-code";
}

async function loginCode(claims: JwtClaims, invId: string, scope: { dealerUuid: string } | { groupId: string }): Promise<NextResponse> {
  const r = await issueInvitationLoginCode(createAdminSupabaseClient(), claims, invId, scope);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, code: r.code, email: r.email, expiresAt: r.expiresAt }, { headers: { "Cache-Control": "no-store" } });
}

// super_admin (any group) or group_admin (own group only).
async function authorize(groupId: string) {
  const { claims, error } = await requireAuth();
  if (error) return { error };
  if (claims.role !== "super_admin" && claims.role !== "group_admin") {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  if (claims.role === "group_admin" && groupId !== claims.group_id) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { error: null as null, claims };
}

/**
 * POST /api/groups/[id]/invitations/[invId] — resend a pending invitation:
 * refresh its 7-day expiry and re-email the existing token. Returns
 * { ok, emailSent, warning? }.
 */
export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { error, claims } = await authorize(params.id);
  if (error) return error;
  if (await wantsLoginCode(req)) return loginCode(claims!, params.invId, { groupId: params.id });

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: inv } = await (admin as any)
    .from("invitations")
    .select("id, email, first_name, last_name, role, token, group_id, accepted_at")
    .eq("id", params.invId)
    .eq("group_id", params.id)
    .maybeSingle() as { data: { id: string; email: string; first_name: string; last_name: string; role: string; token: string; accepted_at: string | null } | null };

  if (!inv) return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
  if (inv.accepted_at) return NextResponse.json({ error: "Invitation already accepted" }, { status: 409 });

  // Refresh expiry + issue a fresh setup code so the resend is good for 7 days.
  const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const setupCode = generateSetupCode();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from("invitations")
    .update({ expires_at: newExpiry, setup_code_hash: hashSetupCode(setupCode), setup_code_expires_at: newExpiry })
    .eq("id", inv.id);

  const { data: group } = await admin.from("groups").select("name").eq("id", params.id).maybeSingle<{ name: string }>();
  const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? "https://app.dealeraddendums.com"}/signup?invite=${inv.token}`;

  let emailSent = true;
  let warning: string | undefined;
  try {
    await sendMandrillEmail({
      subject: `You've been invited to join ${group?.name ?? "your group"} on DA Platform`,
      from_email: "noreply@dealeraddendums.com",
      from_name: "DealerAddendums",
      to: [{ email: inv.email, name: `${inv.first_name} ${inv.last_name}`, type: "to" }],
      html: buildInviteEmail({
        firstName: inv.first_name,
        orgName: group?.name ?? "your group",
        roleLabel: inv.role === "group_admin" ? "Group Admin" : "Group User",
        inviteUrl,
        setupCode,
      }),
    });
  } catch (emailErr) {
    emailSent = false;
    warning = `Could not re-send the email: ${emailErr instanceof Error ? emailErr.message : "send failed"}`;
    console.error("[group-invite resend] Mandrill send failed:", emailErr instanceof Error ? emailErr.message : emailErr);
  }

  return NextResponse.json({ ok: true, emailSent, ...(warning ? { warning } : {}) });
}

/**
 * DELETE /api/groups/[id]/invitations/[invId] — revoke a pending invitation.
 */
export async function DELETE(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { error } = await authorize(params.id);
  if (error) return error;

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: delErr } = await (admin as any)
    .from("invitations")
    .delete()
    .eq("id", params.invId)
    .eq("group_id", params.id);

  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
