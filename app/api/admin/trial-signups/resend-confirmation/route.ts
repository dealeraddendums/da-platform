// POST /api/admin/trial-signups/resend-confirmation  { email }
//
// Staff "Resend" for a signup stuck awaiting Layer 0 confirmation. super_admin
// only; proxies to the marketing app, which owns the lead row and the email.
//
// Never confirms on the prospect's behalf. Re-sending the link is the entire
// remedy available to staff, and that is deliberate: only the mailbox owner
// clicking through can provision, which is what makes Layer 0 work.

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient, fireWrite } from "@/lib/db";
import { resendLeadConfirmation } from "@/lib/pending-signups";
import { invalidatePendingCounts } from "@/lib/pending-signups";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { email?: string } | null;
  const email = body?.email?.trim();
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });

  const result = await resendLeadConfirmation(email);

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // admin_audit shape is (admin_user_id, action, target_dealer_id, metadata) —
  // there is no target_email column, so the address goes in metadata.
  fireWrite((admin as any).from("admin_audit").insert({
    admin_user_id: claims.sub,
    action: "lead_confirmation_resent",
    metadata: { email, outcome: result.outcome },
  }), "admin_audit");

  // A resend doesn't change the count (the lead stays stuck until they click),
  // but the cooldown state the operator sees should be fresh.
  invalidatePendingCounts();

  return NextResponse.json(result);
}
