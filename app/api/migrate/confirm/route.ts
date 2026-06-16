import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/migrate/confirm — Phase 13a.2 STUB.
 *
 * The dealer reaches this from the /migrate review step. The BILLING-SENSITIVE
 * system actions on confirm are Phase 13a.3 and intentionally NOT implemented
 * here (review-queue, da-billing template activation + future nextInvoiceDate,
 * account_type→Paid + HubSpot sync, content-seed, FreshBooks operator-queue,
 * migration_status='migrated', invite consume, rollback). 13a.2 ships the flow
 * UI + the read-only verify; this endpoint returns "pending" so the flow is
 * fully walkable without performing any irreversible action yet.
 */
export async function POST(_req: NextRequest): Promise<NextResponse> {
  return NextResponse.json(
    {
      ok: false,
      pending: true,
      message: "Your details are saved. Final activation is being switched on — our team will confirm your migration shortly. (13a.3)",
    },
    { status: 202 },
  );
}
