import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { getShipment, xpsConfigured } from "@/lib/xps";

/**
 * POST /api/cron/sync-xps-tracking
 *
 * Walks every label_orders row whose xps_status is not 'delivered'/'failed',
 * polls XPS for the latest shipment status, and updates xps_status +
 * xps_tracking_number. Designed to run once daily via the same external
 * cron pattern as /api/cron/purge-old-pdfs (header `x-cron-secret` matched
 * against CRON_SECRET).
 *
 * Returns immediately with { ok: true, queued: N } and processes in the
 * background so the cron caller doesn't block on hundreds of XPS calls.
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

  // Fire-and-forget background poll. Each shipment lookup is independent;
  // we run them serially to avoid rate-limiting XPS.
  void (async () => {
    for (const row of (rows ?? []) as Array<{ id: string; xps_order_id: string; xps_status: string }>) {
      try {
        const shipment = await getShipment(row.xps_order_id);
        if (!shipment) continue;
        const patch: Record<string, unknown> = { xps_status: shipment.status };
        if (shipment.trackingNumber) patch.xps_tracking_number = shipment.trackingNumber;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (admin as any).from("label_orders").update(patch).eq("id", row.id);
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
