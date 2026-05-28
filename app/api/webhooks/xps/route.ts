import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { collectHeaders, validateWebhookSecret } from "@/lib/xps-webhook";

/**
 * POST /api/webhooks/xps  — XPS Shipper "Update Order" webhook.
 *
 * Fires when an order is shipped (tracking number assigned), status changes
 * downstream (delivered, voided), and similar. Replaces the broken
 * /shipments polling cron — XPS's REST list endpoint returns only historical
 * fixtures regardless of filter, so push is the only reliable way to learn
 * a tracking number.
 *
 * Auth: shared secret matching XPS_WEBHOOK_SECRET. Fail-closed (503 if env
 * unset, 401 if missing/wrong). See lib/xps-webhook.ts for the envelopes
 * we accept.
 *
 * Expected payload fields (we tolerate variants):
 *   orderId | orderNumber  → matches our label_orders.xps_order_id
 *   trackingNumber | trackingNumbers[0]
 *   carrierCode | carrier
 *   serviceCode | shippingService
 *   status | fulfillmentStatus     ("shipped" | "delivered" | ...)
 *   bookNumber                     (XPS internal id)
 *   voided                         (boolean)
 *
 * xps_webhook_log captures every call regardless of auth outcome, tagged
 * event_type='xps.shipment_update'.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const raw = await req.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    // Still authorize against headers/query and still log the bad body.
  }

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from("xps_webhook_log").insert({
    event_type: "xps.shipment_update",
    payload,
    headers: collectHeaders(req),
  }).then(() => {}).catch(() => {});

  const auth = validateWebhookSecret(req, payload);
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.status === 503 ? "Webhook not configured" : "Unauthorized" },
      { status: auth.status },
    );
  }

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
