import { NextRequest, NextResponse } from "next/server";
import { inviteUsersForDealer } from "@/lib/migration-invite";

/**
 * GET /api/migration/upgrade?dealer_id=INVENTORY_DEALER_ID&token=MIGRATION_INVITE_TOKEN
 *
 * Called from the legacy platform upgrade link — no JWT required.
 * Token is verified against MIGRATION_INVITE_TOKEN env var.
 *
 * Legacy platform link format:
 *   https://app.dealeraddendums.com/api/migration/upgrade?dealer_id=[INVENTORY_DEALER_ID]&token=[MIGRATION_INVITE_TOKEN]
 *
 * Replace [INVENTORY_DEALER_ID] with the dealer's DEALER_ID from Aurora dealer_dim.
 * Replace [MIGRATION_INVITE_TOKEN] with the value from .env.production (shared with Amran/Alex).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = req.nextUrl;
  const token = searchParams.get("token");
  const dealerId = searchParams.get("dealer_id");

  const expectedToken = process.env.MIGRATION_INVITE_TOKEN;
  if (!expectedToken || token !== expectedToken) {
    return NextResponse.redirect(new URL("/migration/welcome?error=invalid_token", req.url));
  }

  if (!dealerId?.trim()) {
    return NextResponse.redirect(new URL("/migration/welcome?error=missing_dealer", req.url));
  }

  try {
    const result = await inviteUsersForDealer(dealerId.trim());
    const params = new URLSearchParams({
      dealer: result.dealer_name,
      invited: String(result.invited),
    });
    return NextResponse.redirect(new URL(`/migration/welcome?${params}`, req.url));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const params = new URLSearchParams({ error: "dealer_not_found", detail: msg });
    return NextResponse.redirect(new URL(`/migration/welcome?${params}`, req.url));
  }
}
