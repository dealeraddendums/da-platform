import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/billing/print-count — metered-usage source for the Restyler plan
 * (Phase 2). da-billing calls this at invoice generation to price
 * max($150, distinct_vehicles × $2) for a restyler group's cycle.
 *
 * Query: ?group={groups.id UUID} OR ?customer={da-billing customer id —
 *        resolved via groups.billing_customer_id, the natural key da-billing
 *        already holds}, plus &from={iso}&to={iso} (half-open [from, to)).
 *
 * Count basis (Allan, locked): DISTINCT VEHICLES with a CONFIRMED addendum
 * print in the window across ALL the group's member stores — print_history is
 * written by recordPrint at the Send/Download confirm only (a previewed-then-
 * cancelled doc records nothing), and reprints of the same vehicle collapse
 * into one distinct vehicle_id, so nothing here can double-charge a reprint
 * or count a preview.
 *
 * Server-to-server only: X-Webhook-Secret = BILLING_CACHE_WEBHOOK_SECRET
 * (PLATFORM_WEBHOOK_SECRET on the da-billing box) — the same pair as
 * dealer-names / billing-cache-invalidate; no new key to provision. Read-only.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.BILLING_CACHE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }
  if (req.headers.get("x-webhook-secret") !== secret) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const groupParam = url.searchParams.get("group")?.trim() || null;
  const customerParam = url.searchParams.get("customer")?.trim() || null;
  const fromParam = url.searchParams.get("from")?.trim() || "";
  const toParam = url.searchParams.get("to")?.trim() || "";

  const from = new Date(fromParam);
  const to = new Date(toParam);
  if (!fromParam || !toParam || isNaN(from.getTime()) || isNaN(to.getTime()) || from >= to) {
    return NextResponse.json({ error: "from/to must be valid ISO timestamps with from < to" }, { status: 400 });
  }
  if (!groupParam && !customerParam) {
    return NextResponse.json({ error: "group or customer required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // Resolve the group. billing_customer_id is unique per group in practice;
  // if data drift ever produces two groups on one customer, fail loudly
  // rather than merge usage across groups (mis-billing risk).
  let groupId = groupParam;
  if (!groupId) {
    const { data: groups, error } = await admin
      .from("groups")
      .select("id")
      .eq("billing_customer_id", customerParam!);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!groups || groups.length === 0) {
      return NextResponse.json({ error: "No group for that customer" }, { status: 404 });
    }
    if (groups.length > 1) {
      return NextResponse.json({ error: "Multiple groups share that billing customer — resolve by ?group= instead" }, { status: 409 });
    }
    groupId = groups[0].id as string;
  }

  // Member stores → TEXT dealer_ids (print_history keys on the text id).
  const dealerIds: string[] = [];
  const PAGE = 1000;
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await admin
      .from("dealers")
      .select("dealer_id")
      .eq("group_id", groupId)
      .range(start, start + PAGE - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    for (const d of data ?? []) if (d.dealer_id) dealerIds.push(d.dealer_id as string);
    if ((data ?? []).length < PAGE) break;
  }
  if (dealerIds.length === 0) {
    return NextResponse.json({ group_id: groupId, from: from.toISOString(), to: to.toISOString(), stores: 0, print_rows: 0, distinct_vehicles: 0 });
  }

  // Confirmed addendum prints in [from, to) across the stores, distinct by
  // vehicle. Paged past the PostgREST 1000-row clamp.
  const vehicles = new Set<string>();
  let printRows = 0;
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await admin
      .from("print_history")
      .select("vehicle_id")
      .in("dealer_id", dealerIds)
      .eq("document_type", "addendum")
      .gte("created_at", from.toISOString())
      .lt("created_at", to.toISOString())
      .range(start, start + PAGE - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    for (const r of data ?? []) {
      printRows++;
      if (r.vehicle_id != null) vehicles.add(String(r.vehicle_id));
    }
    if ((data ?? []).length < PAGE) break;
  }

  return NextResponse.json({
    group_id: groupId,
    from: from.toISOString(),
    to: to.toISOString(),
    stores: dealerIds.length,
    print_rows: printRows,
    distinct_vehicles: vehicles.size,
  });
}
