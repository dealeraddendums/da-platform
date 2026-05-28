import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { collectHeaders, validateWebhookSecret } from "@/lib/xps-webhook";
import { getOrderWeightLbs } from "@/lib/label-weights";

/**
 * GET /api/webhooks/xps/orders  — XPS Shipper "List Orders" poll URL.
 *
 * XPS polls this every ~30s. We return every label_orders row staged for
 * pickup (xps_status='pending_pull'), formatted as an XPS Order. XPS
 * pulls them, prints the labels, then fires Update Order to
 * POST /api/webhooks/xps with the tracking number — at which point the
 * row flips to xps_status='shipped' and drops off the next poll.
 *
 * This replaces the previous REST PUT flow (orders/labels was PUT-ing
 * each new order to XPS). The PUT path is gone because XPS only fires
 * its Update Order webhook for orders pulled via THIS endpoint — orders
 * pushed via REST don't trigger callbacks, which is why tracking never
 * came back from the earlier shipments.
 *
 * Legacy orders that were PUT to XPS pre-cutover stay at
 * xps_status='created' and are NOT returned here, so XPS doesn't
 * re-create them. They print fine in XPS but their tracking has to be
 * backfilled manually.
 *
 * Auth: same shared-secret check as POST /api/webhooks/xps.
 * Logged with event_type='xps.list_orders'.
 */

function addBusinessDays(date: Date, days: number): Date {
  const result = new Date(date);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    const day = result.getDay();
    if (day !== 0 && day !== 6) added++;
  }
  return result;
}

function toISODate(date: Date): string {
  return date.toISOString().split("T")[0];
}

interface OrderItem {
  sku: string;
  qty: number;
  price: number;
  shipping: "standard" | "fedex";
  productName: string;
}

interface ShipTo {
  name: string;
  company?: string;
  attention?: string;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  zip: string;
  country?: string;
  phone?: string;
}

interface LabelOrderRow {
  id: string;
  xps_order_id: string;
  created_at: string;
  items: OrderItem[];
  ship_to: ShipTo;
  dealer_id: string;
}

interface DealerRow {
  id: string;
  primary_contact: string | null;
}

function buildXpsOrder(order: LabelOrderRow, dealer: DealerRow | null) {
  const createdAt = new Date(order.created_at);
  const dueDate = addBusinessDays(createdAt, 3);
  const items = order.items;
  const shipTo = order.ship_to;
  const xpsOrderId = order.xps_order_id;
  // XPS's webhook list-orders display read our "orderDate: 2026-05-28"
  // as epoch zero (rendered as 12/31/1969 4:33 PM). The REST PUT envelope
  // accepts that ISO-date format fine, but webhook mode wants a full
  // datetime — and we don't know which field name it actually keys on,
  // so populate every plausible spelling with the full ISO timestamp.
  const orderDateISO = createdAt.toISOString();

  return {
    orderId: xpsOrderId,
    orderDate: orderDateISO,
    orderDateTime: orderDateISO,
    dateOrdered: orderDateISO,
    dateReceived: orderDateISO,
    dateCreated: orderDateISO,
    createdAt: orderDateISO,
    placedAt: orderDateISO,
    orderNumber: xpsOrderId,
    fulfillmentStatus: "pending",
    shippingService: items.some(i => i.shipping === "fedex") ? "FedEx" : "Standard",
    shippingTotal: "0.00",
    weightUnit: "lb",
    dimUnit: "in",
    dueByDate: toISODate(dueDate),
    orderGroup: "DealerAddendums",
    contentDescription: items.map(i => `${i.productName} x${i.qty}`).join(", "),
    sender: {
      name: process.env.XPS_SENDER_NAME ?? "",
      company: process.env.XPS_SENDER_COMPANY ?? "",
      address1: process.env.XPS_SENDER_ADDRESS1 ?? "",
      address2: "",
      city: process.env.XPS_SENDER_CITY ?? "",
      state: process.env.XPS_SENDER_STATE ?? "",
      zip: process.env.XPS_SENDER_ZIP ?? "",
      country: "US",
      phone: process.env.XPS_SENDER_PHONE ?? "",
    },
    receiver: {
      // XPS expects "name" = person, "company" = business. shipTo.name
      // is the dealership name (collected from the dealer record), so it
      // belongs in company. The receiver person is the attention contact
      // when entered, otherwise the dealer's primary_contact.
      name: shipTo.attention || dealer?.primary_contact || "",
      company: shipTo.name,
      address1: shipTo.address1,
      address2: shipTo.address2 || "",
      city: shipTo.city,
      state: shipTo.state,
      zip: shipTo.zip,
      country: shipTo.country || "US",
      phone: shipTo.phone || "",
    },
    shipperReference: xpsOrderId,
    shipperReference2: shipTo.attention || null,
    // Each line is ONE shipment of N labels — qty=1 with the label count
    // rolled into the title and the line total as the unit price. Without
    // this XPS computes declared value as price × labelCount (e.g.
    // $455 × 2000 = $910k for one box of 8300-1). Per-line weight is 0
    // for the same reason — XPS multiplies weight by quantity to derive
    // a line total. Real shipment weight lives in packages[0].weight.
    items: items.map((item, i) => ({
      productId: item.sku,
      sku: item.sku,
      title: `${item.productName} x${item.qty}`,
      price: String(item.price),
      quantity: 1,
      weight: "0",
      lineId: String(i + 1),
      imgUrl: "",
      htsNumber: "",
      countryOfOrigin: "US",
    })),
    packages: [{
      weight: String(getOrderWeightLbs(items)),
      length: null,
      width: null,
      height: null,
      insuranceAmount: null,
      declaredValue: null,
    }],
  };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from("xps_webhook_log").insert({
    event_type: "xps.list_orders",
    payload: { query: Object.fromEntries(req.nextUrl.searchParams) },
    raw_body: null,
    headers: collectHeaders(req),
  }).then(() => {}).catch(() => {});

  const auth = validateWebhookSecret(req);
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.status === 503 ? "Webhook not configured" : "Unauthorized" },
      { status: auth.status },
    );
  }

  // Pull every order staged for XPS pickup. The pull-flow was activated
  // 2026-05-28; cap the lookback at 14 days so a forgotten/abandoned row
  // can't sit in the poll response forever.
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const { data: rows, error } = await admin
    .from("label_orders")
    .select("id, xps_order_id, created_at, items, ship_to, dealer_id, xps_status")
    .eq("xps_status", "pending_pull")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(200);

  if (error) {
    console.error("[webhooks/xps/orders] DB read failed:", error.message);
    return NextResponse.json({ orders: [] });
  }

  if (!rows || rows.length === 0) {
    return NextResponse.json({ orders: [] });
  }

  // Look up primary_contact for each unique dealer in one query so we
  // can populate the receiver name when no shipTo.attention was given.
  const dealerIds: string[] = Array.from(
    new Set(rows.map(r => r.dealer_id).filter((d): d is string => typeof d === "string" && d.length > 0))
  );
  const { data: dealerRows } = await admin
    .from("dealers")
    .select("id, primary_contact")
    .in("id", dealerIds);
  const dealerById = new Map((dealerRows ?? []).map(d => [d.id, d as unknown as DealerRow]));

  const orders = (rows as unknown as LabelOrderRow[]).map(r =>
    buildXpsOrder(r, dealerById.get(r.dealer_id) ?? null),
  );

  return NextResponse.json({ orders });
}
