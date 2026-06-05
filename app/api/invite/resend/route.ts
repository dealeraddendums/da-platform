import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { sendMandrillEmail } from "@/lib/mandrill";
import { buildInviteEmail } from "@/lib/invite-email";
import { generateSetupCode, hashSetupCode } from "@/lib/invite-code";
import { rateLimit } from "@/lib/rate-limit";

// POST /api/invite/resend  { token }
// Re-issues a fresh setup code for a pending invitation and re-emails it.
// IDEMPOTENT and non-consuming: it never sets accepted_at and never creates an
// auth user — a scanner (or impatient human) hitting it repeatedly just causes
// another code email. Unauthenticated (the invitee isn't signed in yet), so
// rate-limited per IP and always returns { ok: true } to avoid leaking which
// tokens are valid.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!rateLimit(`invite-resend:${ip}`, 5, 60_000)) {
    return NextResponse.json({ error: "Too many requests — please wait a moment." }, { status: 429 });
  }

  let token: string | undefined;
  try { ({ token } = (await req.json()) as { token?: string }); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!token) return NextResponse.json({ error: "token required" }, { status: 400 });

  try {
    const admin = createAdminSupabaseClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: inv } = await (admin as any)
      .from("invitations")
      .select("id, email, first_name, last_name, role, dealer_id, dealer_name, group_id, expires_at, accepted_at")
      .eq("token", token)
      .maybeSingle() as { data: {
        id: string; email: string; first_name: string; last_name: string;
        role: string; dealer_id: string | null; dealer_name: string | null;
        group_id: string | null; expires_at: string; accepted_at: string | null;
      } | null };

    // Only act on a live, unconsumed invite — but never reveal the outcome.
    if (inv && !inv.accepted_at && new Date(inv.expires_at) >= new Date()) {
      const setupCode = generateSetupCode();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any).from("invitations")
        .update({ setup_code_hash: hashSetupCode(setupCode), setup_code_expires_at: inv.expires_at })
        .eq("id", inv.id);

      let orgName = inv.dealer_name ?? "your account";
      if (inv.group_id) {
        const { data: g } = await admin.from("groups").select("name").eq("id", inv.group_id).maybeSingle<{ name: string }>();
        orgName = g?.name ?? "your group";
      } else if (inv.dealer_id && !inv.dealer_name) {
        const { data: d } = await admin.from("dealers").select("name").eq("id", inv.dealer_id).maybeSingle<{ name: string }>();
        orgName = d?.name ?? "your dealership";
      }

      const roleLabel = inv.role.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? "https://app.dealeraddendums.com"}/signup?invite=${token}`;
      await sendMandrillEmail({
        subject: `Your DA Platform setup code — ${orgName}`,
        from_email: "noreply@dealeraddendums.com",
        from_name: "DealerAddendums",
        to: [{ email: inv.email, name: `${inv.first_name} ${inv.last_name}`, type: "to" }],
        html: buildInviteEmail({ firstName: inv.first_name, orgName, roleLabel, inviteUrl, setupCode }),
      });
    }
  } catch (err) {
    console.error("[invite/resend] failed:", err instanceof Error ? err.message : err);
  }

  return NextResponse.json({ ok: true });
}
