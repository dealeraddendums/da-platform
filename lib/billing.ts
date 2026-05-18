// Server-only client for the da-billing REST API.
// Auth header: X-API-Key, value from BILLING_API_KEY env var.
// Base URL pinned to BILLING_API_BASE or the production default.

const BASE = process.env.BILLING_API_BASE ?? "https://billing.dealeraddendums.com/api/v1";

export function billingConfigured(): boolean {
  return Boolean(process.env.BILLING_API_KEY);
}

function authHeaders(extra: Record<string, string> = {}): HeadersInit {
  const key = process.env.BILLING_API_KEY;
  if (!key) throw new Error("BILLING_API_KEY not set");
  return { "X-API-Key": key, ...extra };
}

async function readBody(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ""; }
}

class BillingError extends Error {
  status: number;
  body: string;
  constructor(status: number, message: string, body: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// ── Customers ────────────────────────────────────────────────────────────────

export interface BillingCustomerInput {
  name: string;          // contact name
  company?: string;      // dealer / group name
  email?: string;
  address?: string;
  phone?: string;
  state?: string;
  isGroup?: boolean;
}

export interface BillingCustomerResponse {
  id: string;
  name?: string;
  company?: string;
  email?: string;
}

export async function createCustomer(input: BillingCustomerInput): Promise<BillingCustomerResponse> {
  const res = await fetch(`${BASE}/customers`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      name: input.name,
      company: input.company,
      email: input.email,
      address: input.address,
      phone: input.phone,
      state: input.state,
      isGroup: input.isGroup ?? false,
    }),
  });
  const text = await readBody(res);
  if (!res.ok) throw new BillingError(res.status, `createCustomer ${res.status}`, text);
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    // da-billing returns the new customer wrapped in `{ customer: {...} }` historically;
    // accept both shapes.
    const customer = (parsed.customer ?? parsed) as BillingCustomerResponse;
    if (!customer?.id) throw new Error("createCustomer response missing id");
    return customer;
  } catch (err) {
    throw new BillingError(res.status, `createCustomer parse: ${(err as Error).message}`, text);
  }
}

export async function archiveCustomer(customerId: string): Promise<void> {
  const res = await fetch(`${BASE}/customers/${encodeURIComponent(customerId)}/archive`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) throw new BillingError(res.status, `archiveCustomer ${res.status}`, await readBody(res));
}

export async function unarchiveCustomer(customerId: string): Promise<void> {
  const res = await fetch(`${BASE}/customers/${encodeURIComponent(customerId)}/unarchive`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) throw new BillingError(res.status, `unarchiveCustomer ${res.status}`, await readBody(res));
}

// ── Templates ────────────────────────────────────────────────────────────────

export interface BillingProduct {
  productId?: string;
  name?: string;
  qty?: number;
  quantity?: number;
  price: number;
  discount?: number;
  lineItemDescription?: string;
  // Label-order shape (used by /api/orders/labels):
  labelType?: string;
  labelQuantity?: string;
}

export interface BillingTemplate {
  customerId: string;
  products: BillingProduct[];
  nextInvoiceDate?: string;
  scheduleInterval?: "monthly" | "yearly";
}

export interface BillingTemplateResponse {
  template: { products: BillingProduct[] } | null;
}

/**
 * GET /templates/customer/:customerId — read the current recurring template.
 * Returns null if no template exists for this customer (server returns 404
 * or { template: null }).
 */
export async function getTemplate(customerId: string): Promise<BillingTemplate | null> {
  const res = await fetch(`${BASE}/templates/customer/${encodeURIComponent(customerId)}`, {
    headers: authHeaders(),
  });
  if (res.status === 404) return null;
  const text = await readBody(res);
  if (!res.ok) throw new BillingError(res.status, `getTemplate ${res.status}`, text);
  try {
    const parsed = JSON.parse(text) as BillingTemplateResponse;
    if (!parsed.template) return null;
    return { customerId, products: parsed.template.products ?? [] };
  } catch (err) {
    throw new BillingError(res.status, `getTemplate parse: ${(err as Error).message}`, text);
  }
}

export interface CreateTemplateInput {
  customerId: string;
  products: BillingProduct[];
  nextInvoiceDate?: string;
  scheduleInterval?: "monthly" | "yearly";
}

/**
 * POST /templates — create a new recurring template. Used the first time
 * a customer is provisioned in da-billing.
 */
export async function createTemplate(input: CreateTemplateInput): Promise<void> {
  const res = await fetch(`${BASE}/templates`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      customerId: input.customerId,
      products: input.products,
      nextInvoiceDate: input.nextInvoiceDate,
      scheduleInterval: input.scheduleInterval ?? "monthly",
    }),
  });
  if (!res.ok) throw new BillingError(res.status, `createTemplate ${res.status}`, await readBody(res));
}

/**
 * PUT /templates/:customerId — replace the template's products array.
 * Caller must merge with existing products before calling; this endpoint
 * does NOT append.
 */
export async function putTemplate(customerId: string, products: BillingProduct[]): Promise<void> {
  const res = await fetch(`${BASE}/templates/${encodeURIComponent(customerId)}`, {
    method: "PUT",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ products }),
  });
  if (!res.ok) throw new BillingError(res.status, `putTemplate ${res.status}`, await readBody(res));
}

/**
 * Append products to whatever the customer's template already has. If no
 * template exists yet, creates one with just these products. Common helper
 * for the label-order and group-cascade flows.
 */
export async function appendToTemplate(customerId: string, products: BillingProduct[]): Promise<void> {
  const current = await getTemplate(customerId);
  if (!current) {
    await createTemplate({ customerId, products });
    return;
  }
  await putTemplate(customerId, [...current.products, ...products]);
}

// ── Pricing lookup (Part 7) ─────────────────────────────────────────────────

export interface BillingPriceEntry {
  name: string;
  price: number;
}

let pricingCache: { fetchedAt: number; entries: BillingPriceEntry[] } | null = null;
const PRICING_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function getPricing(): Promise<BillingPriceEntry[]> {
  const now = Date.now();
  if (pricingCache && now - pricingCache.fetchedAt < PRICING_TTL_MS) {
    return pricingCache.entries;
  }
  const res = await fetch(`${BASE}/pricing`, { headers: authHeaders() });
  const text = await readBody(res);
  if (!res.ok) throw new BillingError(res.status, `getPricing ${res.status}`, text);
  try {
    const parsed = JSON.parse(text);
    // Be permissive about shape: array, { data: [...] }, { products: [...] }.
    const list: unknown[] = Array.isArray(parsed)
      ? parsed
      : (parsed?.data ?? parsed?.products ?? []);
    const entries = list
      .map((r): BillingPriceEntry | null => {
        const row = r as Record<string, unknown>;
        const name = (row.name ?? row.productName ?? row.label) as string | undefined;
        const priceRaw = row.price ?? row.amount ?? row.unitPrice;
        const price = typeof priceRaw === "number" ? priceRaw : parseFloat(String(priceRaw ?? "NaN"));
        if (!name || !Number.isFinite(price)) return null;
        return { name, price };
      })
      .filter((x): x is BillingPriceEntry => x !== null);
    pricingCache = { fetchedAt: now, entries };
    return entries;
  } catch (err) {
    throw new BillingError(res.status, `getPricing parse: ${(err as Error).message}`, text);
  }
}

export async function lookupPrice(productName: string): Promise<number | null> {
  const entries = await getPricing();
  const match = entries.find(e => e.name.toLowerCase() === productName.toLowerCase());
  return match ? match.price : null;
}
