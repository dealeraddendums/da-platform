import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { collectHeaders, validateWebhookSecret } from "@/lib/xps-webhook";

/**
 * GET /api/webhooks/xps/orders  — XPS Shipper "List Orders" poll URL.
 *
 * XPS requires every integration to advertise a URL it can pull pending
 * orders from. We don't use that path — orders are PUT directly to XPS at
 * the moment a dealer places a label order (see app/api/orders/labels/route.ts).
 * So this endpoint exists only to satisfy the integration config and always
 * returns an empty list.
 *
 * Auth: same shared-secret check as POST /api/webhooks/xps. Fail-closed.
 *
 * Logged with event_type='xps.list_orders' so the poll cadence is
 * observable separately from real shipment updates.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from("xps_webhook_log").insert({
    event_type: "xps.list_orders",
    payload: { query: Object.fromEntries(req.nextUrl.searchParams) },
    headers: collectHeaders(req),
  }).then(() => {}).catch(() => {});

  const auth = validateWebhookSecret(req);
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.status === 503 ? "Webhook not configured" : "Unauthorized" },
      { status: auth.status },
    );
  }

  // Empty list, every time. Orders flow OUT to XPS via PUT, never IN.
  return NextResponse.json({ orders: [] });
}
