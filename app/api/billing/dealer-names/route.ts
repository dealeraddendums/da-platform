import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";

/**
 * GET /api/billing/dealer-names — full active-dealer roster for da-billing's
 * "Sync Dealer List" (2026-08-13). Replaces the legacy API Portal's
 * /getdealernames, which died in the api.dealeraddendums.com cutover to
 * da-api-service (route never ported → 404 since 2026-07-03).
 *
 * Server-to-server only: authenticated with the SAME shared secret the
 * da-billing → da-platform cache-invalidate webhook already uses
 * (X-Webhook-Secret = BILLING_CACHE_WEBHOOK_SECRET here,
 * PLATFORM_WEBHOOK_SECRET on the da-billing box) — no new key to provision.
 *
 * internal_id leads the payload because da-billing's dealer picker composes
 * subscription line descriptions as "{id}::{name}" and the platform's own
 * automated staging writes "{internal_id}::{name}" (lib/billing-subscription,
 * group-billing-cascade) — one convention everywhere.
 *
 * Reads page with .range() — PostgREST silently clamps any single read to
 * 1,000 rows and the active fleet is ~2,000+.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.BILLING_CACHE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }
  if (req.headers.get("x-webhook-secret") !== secret) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();
  const PAGE = 1000;
  const dealers: Array<{ internal_id: string | null; dealer_id: string; name: string }> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("dealers")
      .select("internal_id, dealer_id, name")
      .eq("active", true)
      .order("dealer_id")
      .range(from, from + PAGE - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    for (const d of data ?? []) {
      dealers.push({
        internal_id: (d.internal_id as string | null) ?? null,
        dealer_id: d.dealer_id as string,
        name: (d.name as string) ?? "",
      });
    }
    if (!data || data.length < PAGE) break;
  }

  return NextResponse.json({ count: dealers.length, dealers });
}
