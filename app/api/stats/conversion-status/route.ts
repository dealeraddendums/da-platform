import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { isPayingAccount } from "@/lib/hubspot";

/**
 * POST /api/stats/conversion-status — batch paid/converted lookup for the
 * Marketing OS reconcile cron (safety net + initial backfill for the
 * conversion join). Same X-API-Key === SELF_SERVE_API_KEY gate as
 * stats/active-dealers — one shared secret between exactly these two systems.
 *
 * Body: { dealerIds: string[] (ss_* text ids), groupIds: string[] (group UUIDs) }
 * → { [id]: { paid, convertedAt: string|null, plan?: string, mrr?: number } }
 *
 *   - dealer: paid = isPayingAccount(account_type); convertedAt + plan from the row.
 *   - group:  paid = the group has ≥1 active paying member dealer; convertedAt =
 *             earliest such member's converted_at (a "group started paying"
 *             signal — groups have no single account_type). plan omitted.
 *
 * Read-only w.r.t. billing. mrr is left for C3 (sourced via the billing link).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const configuredKey = process.env.SELF_SERVE_API_KEY;
  if (!configuredKey) {
    console.error("[stats/conversion-status] SELF_SERVE_API_KEY not configured — refusing");
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }
  if (req.headers.get("x-api-key") !== configuredKey) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { dealerIds?: string[]; groupIds?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const dealerIds = Array.isArray(body.dealerIds) ? body.dealerIds.filter(Boolean).slice(0, 1000) : [];
  const groupIds = Array.isArray(body.groupIds) ? body.groupIds.filter(Boolean).slice(0, 1000) : [];

  const admin = createAdminSupabaseClient();
  const result: Record<string, { paid: boolean; convertedAt: string | null; plan?: string; mrr?: number }> = {};

  // ── Dealers — keyed by ss_* text id ──────────────────────────────────────
  if (dealerIds.length) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin as any)
      .from("dealers")
      .select("dealer_id, account_type, converted_at")
      .in("dealer_id", dealerIds);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    for (const d of data ?? []) {
      const paid = isPayingAccount(d.account_type);
      result[d.dealer_id] = {
        paid,
        convertedAt: d.converted_at ?? null,
        plan: paid ? (d.account_type ?? undefined) : undefined,
      };
    }
  }

  // ── Groups — keyed by UUID; paid if any active paying member dealer ───────
  if (groupIds.length) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin as any)
      .from("dealers")
      .select("group_id, account_type, converted_at")
      .in("group_id", groupIds)
      .eq("active", true);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    // seed every requested group as not-paid, then upgrade on a paying member
    for (const gid of groupIds) result[gid] = { paid: false, convertedAt: null };
    for (const d of data ?? []) {
      if (!isPayingAccount(d.account_type)) continue;
      const cur = result[d.group_id];
      if (!cur) continue;
      cur.paid = true;
      // earliest paying member's converted_at
      if (d.converted_at && (!cur.convertedAt || d.converted_at < cur.convertedAt)) {
        cur.convertedAt = d.converted_at;
      }
    }
  }

  return NextResponse.json(result);
}
