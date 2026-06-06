import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { sendMandrillEmail } from "@/lib/mandrill";
import { buildInviteEmail } from "@/lib/invite-email";
import { generateSetupCode, hashSetupCode } from "@/lib/invite-code";
import { authorizeDealerAction } from "@/lib/dealer-authz";

type Params = { params: { id: string; invId: string } };

// super_admin (any) / dealer_admin (own) / group_admin (in-group). Mirrors the
// invite-creation guards in POST /api/dealers/[id]/users.
async function authorizeDealer(dealerUuid: string) {
  const { claims, error } = await requireAuth();
  if (error) return { error };
  if (claims.role === "dealer_user" || claims.role === "dealer_restricted") {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  const admin = createAdminSupabaseClient();
  const { data: d } = await admin
    .from("dealers").select("dealer_id").eq("id", dealerUuid)
    .maybeSingle<{ dealer_id: string }>();
  const authz = await authorizeDealerAction(claims, d?.dealer_id ?? null);
  if (!authz.ok) return { error: authz.response };
  return { error: null as null };
}

/** POST — resend a pending dealer invitation (refresh expiry + re-email). */
export async function POST(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { error } = await authorizeDealer(params.id);
  if (error) return error;

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: inv } = await (admin as any)
    .from("invitations")
    .select("id, email, first_name, last_name, role, token, dealer_id, accepted_at")
    .eq("id", params.invId)
    .eq("dealer_id", params.id)
    .maybeSingle() as { data: { id: string; email: string; first_name: string; last_name: string; role: string; token: string; accepted_at: string | null } | null };

  if (!inv) return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
  if (inv.accepted_at) return NextResponse.json({ error: "Invitation already accepted" }, { status: 409 });

  const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const setupCode = generateSetupCode();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from("invitations")
    .update({ expires_at: newExpiry, setup_code_hash: hashSetupCode(setupCode), setup_code_expires_at: newExpiry })
    .eq("id", inv.id);

  const { data: dealer } = await admin.from("dealers").select("name").eq("id", params.id).maybeSingle<{ name: string }>();
  const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? "https://app.dealeraddendums.com"}/signup?invite=${inv.token}`;
  const roleLabel = inv.role === "dealer_admin" ? "Dealer Admin" : inv.role === "dealer_restricted" ? "Dealer Restricted" : "Dealer User";

  let emailSent = true;
  let warning: string | undefined;
  try {
    await sendMandrillEmail({
      subject: `You've been invited to join ${dealer?.name ?? "your dealership"} on DA Platform`,
      from_email: "noreply@dealeraddendums.com",
      from_name: "DealerAddendums",
      to: [{ email: inv.email, name: `${inv.first_name} ${inv.last_name}`, type: "to" }],
      html: buildInviteEmail({ firstName: inv.first_name, orgName: dealer?.name ?? "your dealership", roleLabel, inviteUrl, setupCode }),
    });
  } catch (emailErr) {
    emailSent = false;
    warning = `Could not re-send the email: ${emailErr instanceof Error ? emailErr.message : "send failed"}`;
    console.error("[dealer-invite resend] Mandrill send failed:", emailErr instanceof Error ? emailErr.message : emailErr);
  }

  return NextResponse.json({ ok: true, emailSent, ...(warning ? { warning } : {}) });
}

/** DELETE — revoke a pending dealer invitation. */
export async function DELETE(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { error } = await authorizeDealer(params.id);
  if (error) return error;

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: delErr } = await (admin as any)
    .from("invitations")
    .delete()
    .eq("id", params.invId)
    .eq("dealer_id", params.id);

  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
