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
 * GET /customers/:customerId/shipments?shipperReference=:ref
 *
 * Used by the daily tracking cron to find the shipment XPS created when
 * Virginia printed a label. The path-style GET /shipments/:id endpoint
 * treats the id as an XPS-internal numeric bookNumber (not our DA-*
 * orderId), so the only working linkage is via shipperReference — which
 * the label-order POST sets to our xpsOrderId at order create time.
 *
 * Defensive: XPS has historically ignored filter parameters on this list
 * endpoint, returning the first batch of customer-wide historical
 * shipments instead. We verify that the returned shipment's
 * shipperReference actually matches before treating it as a match, and
 * fall back to scanning shipperReference2 + trackingNumbers in case
 * the linkage flipped fields. Returns null when nothing matches.
 */
export async function findShipmentByReference(reference: string): Promise<XpsShipmentStatus | null> {
  const url = `${BASE}/customers/${customerId()}/shipments?shipperReference=${encodeURIComponent(reference)}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 404) return null;
  const text = await readBody(res);
  if (!res.ok) throw new XpsError(res.status, `findShipmentByReference ${res.status}`, text);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new XpsError(res.status, `findShipmentByReference parse: ${(err as Error).message}`, text);
  }
  const list = (parsed.shipments ?? []) as Array<Record<string, unknown>>;
  // Only accept a hit when the shipment's own reference field genuinely
  // matches what we asked for. XPS's filter param appears to be ignored
  // on the test fixtures we've seen, so this guard prevents the cron
  // from latching onto an unrelated historical shipment.
  const match = list.find(s => {
    if (s.shipperReference === reference) return true;
    if (s.shipperReference2 === reference) return true;
    return false;
  });
  if (!match) return null;
  return {
    status: String(match.status ?? match.fulfillmentStatus ?? "shipped"),
    trackingNumber: (match.trackingNumber ?? (Array.isArray(match.trackingNumbers) ? match.trackingNumbers[0] : null) ?? null) as string | null,
    carrier: (match.carrierCode ?? match.carrier ?? match.serviceProvider ?? null) as string | null,
  };
}

/**
 * GET /customers/:customerId/integrations/:integrationId/orders
 *
 * Returns the set of orders that XPS still considers "active" (not yet
 * fulfilled). Used by the tracking cron as a secondary signal: when one
 * of our previously-PUT xps_order_id values has dropped off this list,
 * we infer the label has been printed (status → 'shipped') even if the
 * shipperReference linkage hasn't surfaced the tracking number yet.
 */
export async function listActiveOrderIds(): Promise<Set<string>> {
  const result = new Set<string>();
  let url: string | null = `${BASE}/customers/${customerId()}/integrations/${integrationId()}/orders?limit=200`;
  while (url) {
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) throw new XpsError(res.status, `listActiveOrderIds ${res.status}`, await readBody(res));
    const parsed = await res.json() as { orders?: Array<{ orderId?: string }>; nextPageUrl?: string | null; hasMore?: boolean };
    for (const o of parsed.orders ?? []) {
      if (o.orderId) result.add(o.orderId);
    }
    url = (parsed.hasMore && parsed.nextPageUrl) ? parsed.nextPageUrl : null;
  }
  return result;
}
