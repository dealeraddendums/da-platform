// Server-only client for XPS Shipper. Auth via "Authorization: RSIS <key>".
// XPS_CUSTOMER_ID is the multi-tenant customer key (DealerAddendums); the
// integration ID is the channel under that customer that DA orders flow
// through.

const BASE = "https://xpsshipper.com/restapi/v1";

export function xpsConfigured(): boolean {
  return Boolean(
    process.env.XPS_API_KEY
      && process.env.XPS_CUSTOMER_ID
      && process.env.XPS_INTEGRATION_ID,
  );
}

function authHeaders(extra: Record<string, string> = {}): HeadersInit {
  const key = process.env.XPS_API_KEY;
  if (!key) throw new Error("XPS_API_KEY not set");
  return { Authorization: `RSIS ${key}`, ...extra };
}

class XpsError extends Error {
  status: number;
  body: string;
  constructor(status: number, message: string, body: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function readBody(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ""; }
}

function customerId(): string {
  const id = process.env.XPS_CUSTOMER_ID;
  if (!id) throw new Error("XPS_CUSTOMER_ID not set");
  return id;
}

function integrationId(): string {
  const id = process.env.XPS_INTEGRATION_ID;
  if (!id) throw new Error("XPS_INTEGRATION_ID not set");
  return id;
}

// ── Orders ───────────────────────────────────────────────────────────────────

export interface XpsAddress {
  name: string;
  company?: string;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string;
}

export interface XpsOrderItem {
  productId: string;
  sku?: string;
  title: string;
  price: string;
  quantity: number;
  weight: string;
  lineId?: string;
}

export interface XpsCreateOrderInput {
  orderId: string;
  orderDate: string;          // YYYY-MM-DD
  orderNumber: string;
  fulfillmentStatus: string;  // "pending"
  shippingService: string;
  shippingTotal: string;
  weightUnit: "lb" | "kg";
  dimUnit: "in" | "cm";
  dueByDate: string;
  orderGroup?: string;
  contentDescription: string;
  sender: XpsAddress;
  receiver: XpsAddress;
  items: XpsOrderItem[];
  packages?: Array<{
    weight: string;
    length: number | null;
    width: number | null;
    height: number | null;
    insuranceAmount: number | null;
    declaredValue: number | null;
  }>;
  shipperReference?: string | null;
}

/**
 * PUT /customers/:customerId/integrations/:integrationId/orders/:orderId
 * Idempotent — same orderId can be sent again without creating duplicates.
 */
export async function createOrder(input: XpsCreateOrderInput): Promise<void> {
  const url = `${BASE}/customers/${customerId()}/integrations/${integrationId()}/orders/${encodeURIComponent(input.orderId)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(input),
  });
  if (!res.ok && res.status !== 201) {
    throw new XpsError(res.status, `createOrder ${res.status}`, await readBody(res));
  }
}

// ── Shipments / tracking ─────────────────────────────────────────────────────

export interface XpsShipmentStatus {
  status: string;          // "pending" | "shipped" | "delivered" | ...
  trackingNumber?: string | null;
  carrier?: string | null;
}

/**
 * GET /customers/:customerId/shipments/:orderId — used by the daily cron to
 * sync xps_status + xps_tracking_number into label_orders. XPS returns the
 * shipment for an order if one exists; otherwise 404.
 */
export async function getShipment(xpsOrderId: string): Promise<XpsShipmentStatus | null> {
  const url = `${BASE}/customers/${customerId()}/shipments/${encodeURIComponent(xpsOrderId)}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 404) return null;
  const text = await readBody(res);
  if (!res.ok) throw new XpsError(res.status, `getShipment ${res.status}`, text);
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    // XPS sometimes nests under { shipment: {...} } — accept both shapes.
    const s = (parsed.shipment ?? parsed) as Record<string, unknown>;
    return {
      status: String(s.status ?? s.fulfillmentStatus ?? "unknown"),
      trackingNumber: (s.trackingNumber ?? s.tracking ?? null) as string | null,
      carrier: (s.carrier ?? s.serviceProvider ?? null) as string | null,
    };
  } catch (err) {
    throw new XpsError(res.status, `getShipment parse: ${(err as Error).message}`, text);
  }
}
