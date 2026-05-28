import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { findShipmentByReference, listActiveOrderIds, xpsConfigured } from "@/lib/xps";

/**
 * POST /api/cron/sync-xps-tracking
 *
 * Walks every label_orders row whose xps_status is not 'delivered'/'failed'
 * and tries two matching strategies:
 *
 *   1. GET /shipments?shipperReference={xps_order_id} — XPS's only working
 *      linkage from our DA-* orderId to a printed shipment. Requires the
 *      order to have been PUT to XPS with shipperReference = xps_order_id
 *      (true for orders placed after the 2026-05-28 fix; older orders set
 *      shipperReference to the receiver attention contact and won't match).
 *
 *   2. Active-order absence — XPS removes an order from the integration's
 *      orders list once Virginia prints the label. If an xps_order_id is
 *      no longer in /integrations/{i}/orders, we infer it was shipped and
 *      flip xps_status to 'shipped'. No tracking number, but the dealer's
 *      Orders tab moves from "Pending shipment" to "Shipped" correctly.
 *
 * Strategy 1 wins when it returns a hit (tracking number populates).
 * Strategy 2 is the fallback for legacy orders + the gap between print
 * and the shipperReference filter actually working on XPS's side.
 *
 * Returns immediately with { ok: true, queued: N } and processes in the
 * background so the cron caller doesn't block.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!xpsConfigured()) {
    return NextResponse.json({ error: "XPS not configured" }, { status: 500 });
  }

  const admin = createAdminSupabaseClient();
  const { data: rows } = await admin
    .from("label_orders")
    .select("id, xps_order_id, xps_status")
    .not("xps_order_id", "is", null)
    .not("xps_status", "in", "(delivered,failed)")
    .limit(1000);

  const queued = (rows ?? []).length;

  // Fire-and-forget background poll. Each lookup is independent; we run
  // them serially to avoid rate-limiting XPS.
  void (async () => {
    // Strategy 2 prerequisite — pull the entire active-orders set once.
    // listActiveOrderIds paginates internally, so this is one set per cron
    // run regardless of how many label_orders we walk.
    let activeIds: Set<string>;
    try {
      activeIds = await listActiveOrderIds();
    } catch (err) {
      console.error("[cron/sync-xps-tracking] listActiveOrderIds failed:", err instanceof Error ? err.message : err);
      activeIds = new Set();
    }

    for (const row of (rows ?? []) as Array<{ id: string; xps_order_id: string; xps_status: string }>) {
      try {
        // Strategy 1 — direct shipperReference lookup.
        const shipment = await findShipmentByReference(row.xps_order_id);
        if (shipment) {
          const patch: Record<string, unknown> = { xps_status: shipment.status || "shipped" };
          if (shipment.trackingNumber) patch.xps_tracking_number = shipment.trackingNumber;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (admin as any).from("label_orders").update(patch).eq("id", row.id);
          continue;
        }

        // Strategy 2 — order vanished from the active list = printed.
        // Only fire when we have a non-empty activeIds set (otherwise the
        // listActiveOrderIds call itself failed and we'd flip every row).
        if (activeIds.size > 0 && !activeIds.has(row.xps_order_id) && row.xps_status === "created") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (admin as any).from("label_orders").update({ xps_status: "shipped" }).eq("id", row.id);
        }
      } catch (err) {
        console.error(
          `[cron/sync-xps-tracking] order ${row.xps_order_id} failed:`,
          err instanceof Error ? err.message : err,
        );
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (admin as any).from("billing_sync_errors").insert({
            event_type: "xps.shipment.poll",
            payload: { label_order_id: row.id, xps_order_id: row.xps_order_id },
            error_message: err instanceof Error ? err.message : String(err),
          });
        } catch { /* swallow */ }
      }
    }
  })();

  return NextResponse.json({ ok: true, queued });
}
