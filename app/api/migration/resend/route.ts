import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { sendMigrationInvite } from "@/lib/migration-invite-otp";

export const dynamic = "force-dynamic";

/**
 * POST /api/migration/resend — Phase 13b step 3 (nudge a stalled/expired invite).
 * super_admin only. Body: { dealerId: <dealers.id UUID> }.
 * Re-fires the OTP migration invite for PENDING recipients only (fresh code
 * each; already-accepted recipients are skipped — the shared completed
 * predicate in lib/migration-invite-otp). Allowed on already-MIGRATED dealers
 * too: the first acceptor migrates the dealer, but the other admins still need
 * their account-only invites — resend reaches exactly the ones who haven't
 * accepted, and never regresses the dealer's migration_status.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  let body: { dealerId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body.dealerId) return NextResponse.json({ error: "dealerId required" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data: dealer } = await admin
    .from("dealers")
    .select("inventory_dealer_id, migration_status, name")
    .eq("id", body.dealerId)
    .maybeSingle<{ inventory_dealer_id: string | null; migration_status: string | null; name: string }>();
  if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });
  if (!dealer.inventory_dealer_id) return NextResponse.json({ error: "Dealer has no inventory_dealer_id." }, { status: 400 });

  try {
    const res = await sendMigrationInvite(dealer.inventory_dealer_id, claims.sub);
    if (!res.allCompleted) {
      // Manual resend restarts the drip: invited_at was just reset by
      // sendMigrationInvite, so zero the follow-up count too. (Skipped when
      // nothing was sent — an all-completed "resend" changes nothing.)
      await admin
        .from("dealers")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .update({ invite_follow_up_count: 0 } as any)
        .eq("id", body.dealerId);
    }
    return NextResponse.json({
      ok: true,
      dealer: dealer.name,
      email: res.email,
      emailSent: res.emailSent,
      recipients: res.recipients,
      skipped: res.skipped,
      allCompleted: res.allCompleted,
      warning: res.warning,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Resend failed" }, { status: 500 });
  }
}
