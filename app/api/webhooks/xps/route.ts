import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { collectHeaders, validateWebhookSecret } from "@/lib/xps-webhook";

/**
 * POST /api/webhooks/xps  — XPS Shipper "Update Order" webhook.
 *
 * Fires when an order is shipped (tracking number assigned), status changes
 * downstream (delivered, voided), and similar.
 *
 * XPS sends this as application/x-www-form-urlencoded, NOT JSON, despite
 * the JSON-looking shape we use on the List Orders endpoint. The first
 * real event (2026-05-28 19:57:07 UTC, 1333 bytes) was silently dropped
 * because the original parser only tried JSON. We now try JSON first,
 * fall back to form-urlencoded, and persist the raw text body to
 * xps_webhook_log.raw_body so any future envelope we don't anticipate
 * can still be recovered post-hoc.
 *
 * Auth: shared secret matching XPS_WEBHOOK_SECRET. Fail-closed.
 *
 * Expected payload fields (we tolerate variants):
 *   orderId | orderNumber  → matches our label_orders.xps_order_id
 *   trackingNumber | trackingNumbers[0]
 *   carrierCode | carrier | carrierName
 *   serviceCode | shippingService
 *   status | fulfillmentStatus     ("shipped" | "delivered" | ...)
 *   bookNumber                     (XPS internal id)
 *   voided                         (boolean)
 *
 * xps_webhook_log captures every call regardless of auth outcome, tagged
 * event_type='xps.shipment_update'.
 */

function parseFormUrlencoded(body: string): Record<string, unknown> {
  const params = new URLSearchParams(body);
  const out: Record<string, unknown> = {};
  // forEach instead of for…of to avoid downlevelIteration on URLSearchParams.
  // Form bodies use repeated keys for arrays (e.g. trackingNumbers=A&trackingNumbers=B);
  // we collapse them into a JS array when we see a second value.
  params.forEach((v, k) => {
    const existing = out[k];
    if (existing === undefined) out[k] = v;
    else if (Array.isArray(existing)) (existing as unknown[]).push(v);
    else out[k] = [existing, v];
  });
  return out;
}

function parseBody(raw: string, contentType: string): Record<string, unknown> {
  if (!raw) return {};
  const ct = contentType.toLowerCase();
  if (ct.includes("application/json")) {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Fall through to form-encoded best-effort.
    }
  }
  if (ct.includes("application/x-www-form-urlencoded")) {
    return parseFormUrlencoded(raw);
  }
  // Unknown content-type: try JSON, then form, then give up with empty.
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    try {
      return parseFormUrlencoded(raw);
    } catch {
      return {};
    }
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const raw = await req.text();
  const contentType = req.headers.get("content-type") ?? "";
  const payload = parseBody(raw, contentType);

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from("xps_webhook_log").insert({
    event_type: "xps.shipment_update",
    payload,
    raw_body: raw,
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
    (typeof ship.trackingNumbers === "string" ? (ship.trackingNumbers as string) : undefined) ??
    null;
  const carrier =
    (ship.carrierCode as string | undefined) ??
    (ship.carrier as string | undefined) ??
    (ship.carrierName as string | undefined) ??
    null;
  const status =
    (ship.status as string | undefined) ??
    (ship.fulfillmentStatus as string | undefined) ??
    (trackingNumber ? "shipped" : "created");
  const voided = ship.voided === true || ship.voided === "true";

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
