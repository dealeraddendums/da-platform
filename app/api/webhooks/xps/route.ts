import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";

/**
 * POST /api/webhooks/xps
 *
 * Inbound webhook from XPS Shipper. XPS fires this when an order is
 * shipped (tracking number assigned) and when status changes downstream.
 * Replaces the broken /shipments polling cron — XPS's REST list endpoint
 * returns only historical fixtures regardless of filter, so the push
 * model is the only reliable way to learn a tracking number.
 *
 * Auth: shared secret in X-Webhook-Secret header, set in XPS's webhook
 * config matching XPS_WEBHOOK_SECRET env var on our side. XPS doesn't
 * sign payloads, so the secret IS the auth.
 *
 * Payload shape is undocumented but observed-to-be a single shipment
 * event with these fields (we tolerate variants):
 *   orderId | orderNumber  → matches our label_orders.xps_order_id
 *   trackingNumber | trackingNumbers[0]
 *   carrierCode | carrier
 *   serviceCode | shippingService
 *   status | fulfillmentStatus     ("shipped" | "delivered" | ...)
 *   bookNumber                     (XPS internal id, for our records)
 *   voided                         (boolean)
 *
 * We log every raw payload to xps_webhook_log table for diagnosis when
 * a field is named something we didn't anticipate.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const expected = process.env.XPS_WEBHOOK_SECRET;
  if (expected) {
    const got = req.headers.get("x-webhook-secret") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (got !== expected) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const raw = await req.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // Always log the raw payload first, so if matching fails we can see
  // what XPS actually sent.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from("xps_webhook_log").insert({
    payload,
    headers: {
      "user-agent": req.headers.get("user-agent"),
      "x-event-type": req.headers.get("x-event-type"),
      "x-event-id": req.headers.get("x-event-id"),
    },
  }).then(() => {}).catch(() => {});

  // Pluck the order identifier — XPS may send any of these.
  const orderId =
    (payload.orderId as string | undefined) ??
    (payload.orderNumber as string | undefined) ??
    (payload.shipperReference as string | undefined) ??
    ((payload.order as { orderId?: string; orderNumber?: string } | undefined)?.orderId) ??
    ((payload.order as { orderId?: string; orderNumber?: string } | undefined)?.orderNumber) ??
    ((payload.shipment as { orderId?: string; orderNumber?: string } | undefined)?.orderId) ??
    ((payload.shipment as { orderId?: string; orderNumber?: string } | undefined)?.orderNumber);

  if (!orderId || !String(orderId).startsWith("DA-")) {
    return NextResponse.json({ ok: true, matched: false, reason: "no DA orderId in payload" });
  }

  const ship = (payload.shipment ?? payload) as Record<string, unknown>;
  const trackingNumber =
    (ship.trackingNumber as string | undefined) ??
    (Array.isArray(ship.trackingNumbers) ? (ship.trackingNumbers as string[])[0] : undefined) ??
    null;
  const carrier =
    (ship.carrierCode as string | undefined) ??
    (ship.carrier as string | undefined) ??
    null;
  const status =
    (ship.status as string | undefined) ??
    (ship.fulfillmentStatus as string | undefined) ??
    (trackingNumber ? "shipped" : "created");
  const voided = Boolean(ship.voided);

  const patch: Record<string, unknown> = {
    xps_status: voided ? "voided" : status,
  };
  if (trackingNumber) patch.xps_tracking_number = trackingNumber;
  if (carrier) patch.xps_carrier = carrier;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any)
    .from("label_orders")
    .update(patch)
    .eq("xps_order_id", orderId)
    .select("id");

  if (error) {
    console.error("[webhooks/xps] update failed:", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    matched: (data?.length ?? 0) > 0,
    orderId,
    patch,
  });
}

// XPS may probe the URL with a GET before activating it.
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true, endpoint: "xps-webhook" });
}
