import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/cron/sync-xps-tracking — RETIRED 2026-05-28.
 *
 * Polling XPS for tracking numbers does not work. Their /shipments REST
 * endpoint silently ignores every filter parameter we tried (shipperReference,
 * orderId, orderNumber, trackingNumber, date range) and returns the same
 * historical 2017 fixtures regardless of input. We cannot reach the
 * just-printed shipment via any GET path.
 *
 * Replaced by the XPS webhook receiver at /api/webhooks/xps — XPS pushes
 * us the orderId + trackingNumber when Virginia prints the label.
 *
 * Route kept as a no-op so existing cron schedules don't 500. Safe to
 * delete the schedule entirely once we confirm the webhook is firing.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    ok: true,
    retired: true,
    replacement: "/api/webhooks/xps",
    note: "XPS /shipments polling is broken; tracking numbers now arrive via webhook push.",
  });
}
