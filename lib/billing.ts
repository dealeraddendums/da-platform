// Server-only client for the da-billing REST API.
// Auth header: X-API-Key, value from BILLING_API_KEY env var.
// Base URL pinned to BILLING_API_BASE or the production default.

const BASE = process.env.BILLING_API_BASE ?? "https://billing.dealeraddendums.com/api/v1";

// Customer-facing da-billing URL (Pay button target). da-billing returns
// paymentUrl values bound to its own runtime host — on the production
// server it serves itself as http://localhost:3009 — so we rebuild the
// URL against the public domain before exposing it to the browser.
// Trailing slash is stripped so concatenation never produces a double slash.
const BILLING_PUBLIC_URL = (process.env.BILLING_PUBLIC_URL ?? "https://billing.dealeraddendums.com").replace(/\/+$/, "");

function publicPaymentUrl(raw: string | undefined, invoiceId: string): string {
  const fallback = `${BILLING_PUBLIC_URL}/?invoice=${encodeURIComponent(invoiceId)}`;
  if (!raw) return fallback;
  try {
    // Preserve only the path + query + hash from the upstream URL. Mutating
    // u.host (WHATWG URL) leaves the existing :3009 port in place when the
    // replacement value has no port, so we rebuild from scratch.
    const u = new URL(raw);
    const path = u.pathname === "/" && !u.search && !u.hash ? "/" : `${u.pathname}${u.search}${u.hash}`;
    return `${BILLING_PUBLIC_URL}${path}`;
  } catch {
    return fallback;
  }
}

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

/**
 * Fetch a single customer from da-billing. Includes contact fields the
 * Billing tab needs (name, email, phone, address, etc.). Returns null
 * when the customer is not found.
 */
export interface BillingCustomerDetail extends BillingCustomerResponse {
  phone?: string | null;
  address?: string | null;
  state?: string | null;
  city?: string | null;
  zip?: string | null;
  country?: string | null;
  isGroup?: boolean | null;
}

export async function getCustomer(customerId: string): Promise<BillingCustomerDetail | null> {
  const res = await fetch(`${BASE}/customers/${encodeURIComponent(customerId)}`, {
    method: "GET",
    headers: authHeaders(),
  });
  if (res.status === 404) return null;
  const text = await readBody(res);
  if (!res.ok) throw new BillingError(res.status, `getCustomer ${res.status}`, text);
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return (parsed.customer ?? parsed) as BillingCustomerDetail;
  } catch (err) {
    throw new BillingError(res.status, `getCustomer parse: ${(err as Error).message}`, text);
  }
}

/**
 * Update contact fields on a da-billing customer. Only fields explicitly
 * passed are forwarded — partial update semantics. Returns the updated
 * customer record from da-billing.
 */
export interface BillingCustomerUpdate {
  name?: string;
  company?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
}

export async function updateCustomer(
  customerId: string,
  fields: BillingCustomerUpdate,
): Promise<BillingCustomerDetail> {
  const res = await fetch(`${BASE}/customers/${encodeURIComponent(customerId)}`, {
    method: "PUT",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(fields),
  });
  const text = await readBody(res);
  if (!res.ok) throw new BillingError(res.status, `updateCustomer ${res.status}`, text);
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return (parsed.customer ?? parsed) as BillingCustomerDetail;
  } catch (err) {
    throw new BillingError(res.status, `updateCustomer parse: ${(err as Error).message}`, text);
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
  /** Optional — DA Platform omits this field entirely; da-billing
   *  resolves the canonical price from its Pricing config based on
   *  productId at template save time. */
  price?: number;
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

/**
 * DELETE /templates/:customerId — remove the customer's recurring
 * template entirely. Used when a group's last subscription line is
 * removed (cascadeOnGroupUnassign) since da-billing rejects empty
 * or sub-less templates on PUT. A 404 is treated as success (the
 * template is already gone).
 */
export async function deleteTemplate(customerId: string): Promise<void> {
  const res = await fetch(`${BASE}/templates/${encodeURIComponent(customerId)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (res.status === 404) return;
  if (!res.ok) throw new BillingError(res.status, `deleteTemplate ${res.status}`, await readBody(res));
}

// ── Pricing lookup (Part 7) ─────────────────────────────────────────────────

export interface BillingPriceEntry {
  name: string;
  price: number;
}

let pricingCache: { fetchedAt: number; entries: BillingPriceEntry[] } | null = null;
const PRICING_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Parse the /pricing response. Verified shape (2026-05-18):
 *   { "pricing": { "sub-manual": 100, "sub-auto-web": 150, "sub-auto-dms": 200 } }
 * Falls back to legacy array shapes ({data: [...]}, {products: [...]})
 * just in case da-billing renames things later.
 */
export async function getPricing(): Promise<BillingPriceEntry[]> {
  const now = Date.now();
  if (pricingCache && now - pricingCache.fetchedAt < PRICING_TTL_MS) {
    return pricingCache.entries;
  }
  const res = await fetch(`${BASE}/pricing`, { headers: authHeaders() });
  const text = await readBody(res);
  if (!res.ok) throw new BillingError(res.status, `getPricing ${res.status}`, text);
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const map = (parsed?.pricing ?? null) as Record<string, unknown> | null;
    let entries: BillingPriceEntry[] = [];
    if (map && typeof map === "object" && !Array.isArray(map)) {
      entries = Object.entries(map)
        .map(([k, v]): BillingPriceEntry | null => {
          const price = typeof v === "number" ? v : parseFloat(String(v ?? "NaN"));
          if (!Number.isFinite(price)) return null;
          return { name: k, price };
        })
        .filter((x): x is BillingPriceEntry => x !== null);
    } else {
      // Legacy array fallback.
      const list: unknown[] = Array.isArray(parsed)
        ? parsed
        : (parsed?.data as unknown[] ?? parsed?.products as unknown[] ?? []);
      entries = list
        .map((r): BillingPriceEntry | null => {
          const row = r as Record<string, unknown>;
          const name = (row.name ?? row.productName ?? row.label ?? row.id) as string | undefined;
          const priceRaw = row.price ?? row.amount ?? row.unitPrice;
          const price = typeof priceRaw === "number" ? priceRaw : parseFloat(String(priceRaw ?? "NaN"));
          if (!name || !Number.isFinite(price)) return null;
          return { name, price };
        })
        .filter((x): x is BillingPriceEntry => x !== null);
    }
    pricingCache = { fetchedAt: now, entries };
    return entries;
  } catch (err) {
    throw new BillingError(res.status, `getPricing parse: ${(err as Error).message}`, text);
  }
}

// ── Invoices (for the dealer Billing tab) ───────────────────────────────────

export interface BillingInvoice {
  id: string;
  invoiceNumber?: string | number;
  date: string;
  dueDate?: string;
  total: number;
  status: "pending" | "paid" | "overdue" | "void" | string;
  items?: Array<{
    description?: string;
    productId?: string;
    price?: number;
    quantity?: number;
    discount?: number;
    lineItemDescription?: string;
  }>;
  paymentUrl?: string;
}

export interface ListInvoicesResult {
  invoices: BillingInvoice[];
  total: number;
  outstandingAmount: number;
}

/**
 * GET /invoices?customerId=<uuid> — returns invoices for one customer plus
 * a computed outstandingAmount (sum of pending + overdue totals). The
 * paymentUrl on each invoice points to the dealer-facing pay page.
 */
export async function listInvoices(customerId: string): Promise<ListInvoicesResult> {
  const url = `${BASE}/invoices?customerId=${encodeURIComponent(customerId)}&pageSize=200`;
  const res = await fetch(url, { headers: authHeaders() });
  const text = await readBody(res);
  if (!res.ok) throw new BillingError(res.status, `listInvoices ${res.status}`, text);
  try {
    const parsed = JSON.parse(text) as { invoices?: BillingInvoice[]; total?: number };
    const invoices = (parsed.invoices ?? []).map((inv) => ({
      ...inv,
      paymentUrl: publicPaymentUrl(inv.paymentUrl, inv.id),
    }));
    const outstandingAmount = invoices
      .filter((inv) => inv.status === "pending" || inv.status === "overdue")
      .reduce((sum, inv) => sum + (Number(inv.total) || 0), 0);
    return {
      invoices,
      total: parsed.total ?? invoices.length,
      outstandingAmount,
    };
  } catch (err) {
    throw new BillingError(res.status, `listInvoices parse: ${(err as Error).message}`, text);
  }
}

export async function lookupPrice(productKey: string): Promise<number | null> {
  const entries = await getPricing();
  const match = entries.find(e => e.name.toLowerCase() === productKey.toLowerCase());
  return match ? match.price : null;
}

/**
 * Descriptor for the three monthly subscription tiers as exposed by
 * da-billing. `key` is the lookup id used in /pricing and as the
 * productId on template line items. `name` is the human-readable label
 * shown in da-billing's UI + invoices.
 */
export interface SubscriptionDescriptor {
  key: "sub-manual" | "sub-auto-web" | "sub-auto-dms";
  name: string;
}

const SUBSCRIPTION_TIERS: Record<string, SubscriptionDescriptor> = {
  "sub-manual":   { key: "sub-manual",   name: "Monthly Subscription Manual" },
  "sub-auto-web": { key: "sub-auto-web", name: "Monthly Subscription Automatic Web" },
  "sub-auto-dms": { key: "sub-auto-dms", name: "Monthly Subscription Automatic DMS" },
};

/**
 * Map a DA Platform dealers.account_type to the da-billing subscription
 * descriptor. Accepts both short forms ("Manual"), snake_case
 * ("automatic_dms"), and full product names ("Monthly Subscription
 * Manual"). Returns null for trial / free / inactive / unknown so the
 * template-create step is skipped.
 */
export function subscriptionDescriptorFor(accountType: string | null | undefined): SubscriptionDescriptor | null {
  if (!accountType) return null;
  const a = accountType.trim().toLowerCase();
  if (a === "manual" || a === "monthly subscription manual" || a === "sub-manual") {
    return SUBSCRIPTION_TIERS["sub-manual"];
  }
  if (
    a === "automatic web" || a === "automatic_web" ||
    a === "monthly subscription automatic web" || a === "sub-auto-web"
  ) {
    return SUBSCRIPTION_TIERS["sub-auto-web"];
  }
  if (
    a === "automatic dms" || a === "automatic_dms" ||
    a === "monthly subscription automatic dms" || a === "sub-auto-dms"
  ) {
    return SUBSCRIPTION_TIERS["sub-auto-dms"];
  }
  return null;
}

/**
 * First-of-next-month ISO date string (YYYY-MM-DD) — used as the
 * nextInvoiceDate for a fresh subscription template.
 */
export function firstOfNextMonthIso(now: Date = new Date()): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return next.toISOString().slice(0, 10);
}
