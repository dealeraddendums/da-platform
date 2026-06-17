import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { sendMigrationInvite } from "@/lib/migration-invite-otp";

export const dynamic = "force-dynamic";

/**
 * POST /api/migration/resend — Phase 13b step 3 (nudge a stalled/expired invite).
 * super_admin only. Body: { dealerId: <dealers.id UUID> }.
 * Re-fires the OTP migration invite (idempotent upsert — fresh code, resets
 * invited_at so the stall clock restarts). Only for dealers not yet migrated.
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
  if (dealer.migration_status === "migrated") return NextResponse.json({ error: "Already migrated." }, { status: 409 });
  if (!dealer.inventory_dealer_id) return NextResponse.json({ error: "Dealer has no inventory_dealer_id." }, { status: 400 });

  try {
    const res = await sendMigrationInvite(dealer.inventory_dealer_id, claims.sub);
    return NextResponse.json({ ok: true, dealer: dealer.name, email: res.email, emailSent: res.emailSent, warning: res.warning });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Resend failed" }, { status: 500 });
  }
}
