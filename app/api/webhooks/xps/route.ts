import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
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
 * Auth: a shared secret matching XPS_WEBHOOK_SECRET. XPS doesn't sign
 * payloads, so the secret IS the auth. The route fails closed — if
 * XPS_WEBHOOK_SECRET isn't set in env we 503, and any call without a
 * matching secret 401s. The secret is accepted in any of:
 *   • X-Webhook-Secret / X-XPS-Secret / X-Api-Key / X-Secret-Key headers
 *   • Authorization: Bearer <secret>  (or bare Authorization: <secret>)
 *   • secret / secretKey / apiKey field in the JSON body
 * because XPS's docs don't specify which envelope they use. As soon as a
 * real XPS call arrives, xps_webhook_log will show the exact location and
 * we can tighten this to just that one check.
 *
 * Payload shape is undocumented but the observed/expected fields are:
 *   orderId | orderNumber  → matches our label_orders.xps_order_id
 *   trackingNumber | trackingNumbers[0]
 *   carrierCode | carrier
 *   serviceCode | shippingService
 *   status | fulfillmentStatus     ("shipped" | "delivered" | ...)
 *   bookNumber                     (XPS internal id)
 *   voided                         (boolean)
 *
 * xps_webhook_log captures the raw payload AND every request header on
 * every call — including the failed-auth attempts — so we can see which
 * field XPS puts the secret in and adjust if the auto-detect missed it.
 */

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function extractSecret(req: NextRequest, body: Record<string, unknown>): string | null {
  const headerNames = ["x-webhook-secret", "x-xps-secret", "x-api-key", "x-secret-key", "x-shared-secret"];
  for (const h of headerNames) {
    const v = req.headers.get(h);
    if (v) return v.trim();
  }
  const auth = req.headers.get("authorization");
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    return (m ? m[1] : auth).trim();
  }
  for (const k of ["secret", "secretKey", "apiKey", "webhookSecret"]) {
    const v = body[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function collectHeaders(req: NextRequest): Record<string, string> {
  const out: Record<string, string> = {};
  req.headers.forEach((v, k) => { out[k] = v; });
  return out;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const expected = process.env.XPS_WEBHOOK_SECRET;
  if (!expected) {
    console.error("[webhooks/xps] XPS_WEBHOOK_SECRET not configured — refusing all webhook calls");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  }

  const raw = await req.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    // Still log the bad body so we can see what XPS actually sent — but
    // we can't read a secret out of it, so authorize against headers only.
  }

  const headers = collectHeaders(req);
  const admin = createAdminSupabaseClient();

  // Log first so we have an audit trail even if validation fails. Headers
  // are logged verbatim (including the secret if XPS sent it) because
  // we're still discovering which field XPS uses; once we know we can
  // redact in a follow-up.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from("xps_webhook_log").insert({
    payload,
    headers,
  }).then(() => {}).catch(() => {});

  const provided = extractSecret(req, payload);
  if (!provided || !safeEqual(provided, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
