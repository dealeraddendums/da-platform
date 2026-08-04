import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import {
  PENDING_INVITATION_COLUMNS,
  isPendingInvitation,
  resendPendingInvitationEmail,
  type PendingInvitationRow,
} from "@/lib/invite-resend";

// POST /api/invite/resend  { token }
// Re-issues a fresh setup code for a pending invitation and re-emails it.
// IDEMPOTENT and non-consuming: it never sets accepted_at and never creates an
// auth user — a scanner (or impatient human) hitting it repeatedly just causes
// another code email. Unauthenticated (the invitee isn't signed in yet), so
// rate-limited per IP and always returns { ok: true } to avoid leaking which
// tokens are valid. Send logic shared with the otp-login invitation fallback
// (lib/invite-resend.ts).
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
      .select(PENDING_INVITATION_COLUMNS)
      .eq("token", token)
      .maybeSingle() as { data: PendingInvitationRow | null };

    // Only act on a live, unconsumed invite — but never reveal the outcome.
    if (isPendingInvitation(inv)) {
      await resendPendingInvitationEmail(admin, inv);
    }
  } catch (err) {
    console.error("[invite/resend] failed:", err instanceof Error ? err.message : err);
  }

  return NextResponse.json({ ok: true });
}
