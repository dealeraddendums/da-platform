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
  /** The dealer's / group's `internal_id`. da-billing stores it on the customer
   *  and uses it to resolve group-billed membership (the "G" badge) against the
   *  `{internal_id}::{name}` line descriptions we write on group templates.
   *  Without it da-billing falls back to matching the dealer NAME, which breaks
   *  silently on a rename. Always pass it when it is known. */
  internalId?: string;
  /** Billing lifecycle on create. Omit for the default ('setup' — invoices
   *  generate but email is held until go-live, used for migration onboarding);
   *  pass 'active' only when the dealer is paying now and must be billed
   *  immediately (self-pay upgrade paths). */
  billingState?: "setup" | "active";
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
      ...(input.internalId ? { internalId: input.internalId } : {}),
      // Only sent when explicitly provided; omitted => da-billing defaults to
      // 'setup' (migration onboarding). Self-pay upgrade paths pass 'active'.
      ...(input.billingState ? { billingState: input.billingState } : {}),
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
  /** 'setup' (staged, invoices held) | 'active' (live). */
  billingState?: string | null;
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
 * Link-don't-duplicate guard: returns true if `customerId` still resolves to a
 * da-billing customer. Migrated platform rows already carry the da-billing
 * customer UUID in `billing_id`; before creating a new customer, callers check
 * this and LINK the existing one instead (avoids duplicating ~1.8k customers).
 * A transient da-billing error throws (caller decides); a clean 404 → false.
 */
export async function customerExists(customerId: string | null | undefined): Promise<boolean> {
  if (!customerId) return false;
  return (await getCustomer(customerId)) != null;
}

export interface BillingCustomerMatch { id: string; name?: string; company?: string; email?: string; }

/**
 * Soft-match lookup: active da-billing customers whose company/name/email contain
 * `query` (da-billing's GET /customers?search= is a case-insensitive substring
 * match). Used by the create-customer guard to surface a *possible* existing
 * customer for manual review — NOT for auto-linking (email/company is collision-
 * prone; only the exact billing_id link is auto-applied).
 */
export async function searchCustomers(query: string): Promise<BillingCustomerMatch[]> {
  const q = (query ?? "").trim();
  if (!q) return [];
  const res = await fetch(`${BASE}/customers?search=${encodeURIComponent(q)}&status=active&pageSize=200`, { headers: authHeaders() });
  const text = await readBody(res);
  if (!res.ok) throw new BillingError(res.status, `searchCustomers ${res.status}`, text);
  try {
    const parsed = JSON.parse(text) as { customers?: BillingCustomerMatch[] } | BillingCustomerMatch[];
    return Array.isArray(parsed) ? parsed : (parsed.customers ?? []);
  } catch (err) {
    throw new BillingError(res.status, `searchCustomers parse: ${(err as Error).message}`, text);
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

// ── Additional invoice recipients (da-billing `customer_email:` rows) ───────
// da-billing sends invoices to customer.email (primary) PLUS every
// customer_email row with receiveInvoices=true && !isPrimary. There is no
// server-side upsert — POST 400s on duplicates — so callers list-then-add.

export interface BillingCustomerEmail {
  id: string;
  customerId: string;
  email: string;
  label?: string;
  isPrimary?: boolean;
  receiveInvoices?: boolean;
}

/** GET /customers/:id/emails — the customer's additional invoice recipients. */
export async function listCustomerEmails(customerId: string): Promise<BillingCustomerEmail[]> {
  const res = await fetch(`${BASE}/customers/${encodeURIComponent(customerId)}/emails`, {
    headers: authHeaders(),
  });
  const text = await readBody(res);
  if (!res.ok) throw new BillingError(res.status, `listCustomerEmails ${res.status}`, text);
  try {
    const parsed = JSON.parse(text) as { emails?: BillingCustomerEmail[] };
    return parsed.emails ?? [];
  } catch (err) {
    throw new BillingError(res.status, `listCustomerEmails parse: ${(err as Error).message}`, text);
  }
}

/** POST /customers/:id/emails — add an additional invoice recipient.
 *  da-billing 400s on a duplicate (case-insensitive); callers should check
 *  listCustomerEmails first for idempotent flows. */
export async function addCustomerEmail(
  customerId: string,
  email: string,
  label?: string,
): Promise<BillingCustomerEmail> {
  const res = await fetch(`${BASE}/customers/${encodeURIComponent(customerId)}/emails`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ email, label: label ?? "Billing contact", receiveInvoices: true }),
  });
  const text = await readBody(res);
  if (!res.ok) throw new BillingError(res.status, `addCustomerEmail ${res.status}`, text);
  try {
    const parsed = JSON.parse(text) as { email?: BillingCustomerEmail };
    if (!parsed.email) throw new Error("missing email in response");
    return parsed.email;
  } catch (err) {
    throw new BillingError(res.status, `addCustomerEmail parse: ${(err as Error).message}`, text);
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

/**
 * Activate (or deactivate) a customer's recurring template WITHOUT touching its
 * products/prices — Phase 13a migration confirm + rollback. On activate, pass a
 * FUTURE nextInvoiceDate (the no-double-bill guardrail); the daily cron issues
 * the first invoice on that date. Group-billed dealers pass the GROUP's customer
 * id. Throws on failure so the caller can surface/queue it.
 */
export async function setTemplateStatus(
  customerId: string,
  active: boolean,
  nextInvoiceDate?: string,
): Promise<{ active: boolean; nextInvoiceDate?: string | null }> {
  const res = await fetch(`${BASE}/templates/${encodeURIComponent(customerId)}/set-status`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ active, ...(nextInvoiceDate ? { nextInvoiceDate } : {}) }),
  });
  const text = await readBody(res);
  if (!res.ok) throw new BillingError(res.status, `setTemplateStatus ${res.status}`, text);
  try {
    const parsed = JSON.parse(text) as { template?: { active: boolean; nextInvoiceDate?: string | null } };
    return parsed.template ?? { active };
  } catch (err) {
    throw new BillingError(res.status, `setTemplateStatus parse: ${(err as Error).message}`, text);
  }
}

/** Migration confirm: activate the template with a future nextInvoiceDate. */
export function activateTemplate(customerId: string, nextInvoiceDate: string) {
  return setTemplateStatus(customerId, true, nextInvoiceDate);
}

/** Rollback: pause the template (no further invoicing). */
export function deactivateTemplate(customerId: string) {
  return setTemplateStatus(customerId, false);
}

/**
 * Set a customer's billing lifecycle in da-billing: 'setup' (invoices generate
 * but the dealer email is held) or 'active' (fully live — generate + email).
 * Used by the migration activate-billing action to take a dealer out of setup
 * mode when its template is un-paused. Throws on failure.
 */
export async function setBillingState(
  customerId: string,
  billingState: "setup" | "active",
): Promise<{ billingState: string }> {
  const res = await fetch(`${BASE}/customers/${encodeURIComponent(customerId)}/set-billing-state`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ billingState }),
  });
  const text = await readBody(res);
  if (!res.ok) throw new BillingError(res.status, `setBillingState ${res.status}`, text);
  try {
    const parsed = JSON.parse(text) as { billingState?: string };
    return { billingState: parsed.billingState ?? billingState };
  } catch (err) {
    throw new BillingError(res.status, `setBillingState parse: ${(err as Error).message}`, text);
  }
}

/**
 * Bulk-list every da-billing recurring template (one big-page call) → a map of
 * customerId → { active, nextInvoiceDate }. Used by the migration readiness
 * console to compute "billing template staged" for many dealers without a
 * per-dealer round trip. Returns an empty map (never throws) on a billing hiccup
 * so the console degrades gracefully.
 */
export async function listBillingTemplatesByCustomer(): Promise<Map<string, { active?: boolean; nextInvoiceDate?: string | null; billingState?: string }>> {
  const map = new Map<string, { active?: boolean; nextInvoiceDate?: string | null; billingState?: string }>();
  try {
    const res = await fetch(`${BASE}/templates?pageSize=100000&status=all`, { headers: authHeaders() });
    if (!res.ok) return map;
    const parsed = JSON.parse(await readBody(res)) as { templates?: Array<{ customerId?: string; active?: boolean; nextInvoiceDate?: string | null; billingState?: string }> };
    for (const t of parsed.templates ?? []) {
      if (t.customerId) map.set(t.customerId, { active: t.active, nextInvoiceDate: t.nextInvoiceDate ?? null, billingState: t.billingState });
    }
  } catch {
    // degrade gracefully — readiness shows billing as "unknown/not staged"
  }
  return map;
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
  /** Recurring-billing gate (false = paused / setup staging). */
  active?: boolean;
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
    const parsed = JSON.parse(text) as {
      template:
        | (BillingTemplateResponse["template"] & { nextInvoiceDate?: string; scheduleInterval?: "monthly" | "yearly"; active?: boolean })
        | null;
    };
    if (!parsed.template) return null;
    return {
      customerId,
      products: parsed.template.products ?? [],
      nextInvoiceDate: parsed.template.nextInvoiceDate,
      scheduleInterval: parsed.template.scheduleInterval,
      active: parsed.template.active,
    };
  } catch (err) {
    throw new BillingError(res.status, `getTemplate parse: ${(err as Error).message}`, text);
  }
}

export interface CreateTemplateInput {
  customerId: string;
  products: BillingProduct[];
  nextInvoiceDate?: string;
  scheduleInterval?: "monthly" | "yearly";
  /** `false` creates the template PAUSED. da-billing otherwise creates it live
   *  with nextInvoiceDate = tonight 23:00 ET, i.e. billing on the next cron
   *  run — wrong for a template that is only being staged ahead of a cutover. */
  active?: boolean;
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
      ...(input.active === false ? { active: false } : {}),
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
 * Append products, but when this is the customer's FIRST template, create it
 * PAUSED rather than live.
 *
 * A brand-new template is born active with nextInvoiceDate = tonight 23:00 ET,
 * so creating one bills on the very next cron run. For the group-billing
 * cascade that is exactly wrong: the cascade fires whenever a group-billed
 * dealer is added to a group, including groups that have not been cut over to
 * da-billing at all and are still invoiced in FreshBooks. On 2026-09-05 adding
 * one rooftop to Acrisure minted that group's first template, live, hours
 * before the cron — while FreshBooks was billing all seven of its rooftops
 * $945/mo on the same day. Nothing had been lost; something had been wrongly
 * switched on.
 *
 * Appending to a template that already exists is unchanged: that group is
 * already live (or already deliberately paused) and the caller must not flip
 * its state as a side effect of adding a member.
 *
 * Returns true when the template was created paused, so the caller can
 * say so in its audit trail.
 */
export async function appendToTemplateStagedIfNew(
  customerId: string,
  products: BillingProduct[],
): Promise<{ createdPaused: boolean }> {
  const current = await getTemplate(customerId);
  if (!current) {
    await createTemplate({ customerId, products, active: false });
    return { createdPaused: true };
  }
  await putTemplate(customerId, [...current.products, ...products]);
  return { createdPaused: false };
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

/**
 * GET /invoices/:id/pdf — da-billing serves the invoice as rendered **HTML**
 * (despite the path), public/no-auth "for sharing". We only ever reach it
 * through the authenticated da-platform proxy + ownership check, and convert
 * to a real PDF via da-pdf-service on download. Returns the HTML string.
 */
export async function fetchInvoiceHtml(invoiceId: string): Promise<string> {
  const res = await fetch(`${BASE}/invoices/${encodeURIComponent(invoiceId)}/pdf`, {
    headers: authHeaders(),
  });
  const text = await readBody(res);
  if (!res.ok) throw new BillingError(res.status, `fetchInvoiceHtml ${res.status}`, text);
  return text;
}

// ── Billing status (past-due print lock) ────────────────────────────────────

export interface BillingExtensionState {
  active: boolean;
  protectedUntil: string | null;
  lastRequestedAt: string | null;
  nextEligibleAt: string | null;
  canRequest: boolean;
}

export interface BillingStatus {
  past_due: boolean;
  outstanding_balance: number;
  oldest_overdue_date: string | null;
  overdue_days: number;
  /** Self-service 10-day extension state (2026-08-17). Absent from older
   *  da-billing builds — treat undefined as "feature unavailable". */
  extension?: BillingExtensionState;
}

export interface ExtensionRequestResult {
  granted: boolean;
  reason?: "no_balance" | "throttled";
  protectedUntil?: string;
  nextEligibleAt?: string;
}

/**
 * POST /customers/{id}/request-extension — auto-granted one-time 10-day
 * past-due grace (one per rolling 90 days, enforced by da-billing). Grace
 * window only: no invoice/Stripe/amount side effects.
 */
export async function requestBillingExtension(customerId: string, requestedBy: string | null): Promise<ExtensionRequestResult> {
  const res = await fetch(`${BASE}/customers/${encodeURIComponent(customerId)}/request-extension`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ requestedBy }),
  });
  const text = await readBody(res);
  if (!res.ok) throw new BillingError(res.status, `requestExtension ${res.status}`, text);
  try {
    return JSON.parse(text) as ExtensionRequestResult;
  } catch (err) {
    throw new BillingError(res.status, `requestExtension parse: ${(err as Error).message}`, text);
  }
}

/**
 * GET /customers/{id}/billing-status — da-billing's authoritative past-due read,
 * computed against the customer's per-customer Overdue Days grace. Used by the
 * print gate (lib/print-eligibility.ts). Returns null on 404 (no such customer).
 * Throws on any other error so the caller can FAIL OPEN (never block a paying
 * dealer on a billing-service hiccup).
 */
export async function getBillingStatus(customerId: string): Promise<BillingStatus | null> {
  const res = await fetch(`${BASE}/customers/${encodeURIComponent(customerId)}/billing-status`, {
    method: "GET",
    headers: authHeaders(),
  });
  if (res.status === 404) return null;
  const text = await readBody(res);
  if (!res.ok) throw new BillingError(res.status, `getBillingStatus ${res.status}`, text);
  try {
    return JSON.parse(text) as BillingStatus;
  } catch (err) {
    throw new BillingError(res.status, `getBillingStatus parse: ${(err as Error).message}`, text);
  }
}

export async function lookupPrice(productKey: string): Promise<number | null> {
  const entries = await getPricing();
  const match = entries.find(e => e.name.toLowerCase() === productKey.toLowerCase());
  return match ? match.price : null;
}

// ── Gross-billable trend + current MRR (BI tab) ─────────────────────────────

export interface GrossBillableResult {
  /** One entry per calendar month in [from, to], gaps filled with 0. */
  series: { month: string; grossBilled: number }[];
  /** Forward run-rate from active recurring templates (post-discount). */
  currentMrr: number;
}

/**
 * GET /reports/gross-billable?from=&to= — monthly invoiced totals
 * (post-discount, what we actually billed) plus the current MRR run-rate.
 * Source of truth for the BI tab's revenue section. `from`/`to` are
 * YYYY-MM-DD. Throws (BillingError) on any non-OK so the caller can decide
 * how to surface a da-billing outage.
 */
export async function getGrossBillable(
  from: string,
  to: string,
  excludeCustomerIds: string[] = [],
): Promise<GrossBillableResult> {
  let url = `${BASE}/reports/gross-billable?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  if (excludeCustomerIds.length > 0) {
    url += `&excludeCustomerIds=${encodeURIComponent(excludeCustomerIds.join(","))}`;
  }
  const res = await fetch(url, { headers: authHeaders() });
  const text = await readBody(res);
  if (!res.ok) throw new BillingError(res.status, `getGrossBillable ${res.status}`, text);
  try {
    const parsed = JSON.parse(text) as Partial<GrossBillableResult>;
    return {
      series: Array.isArray(parsed.series) ? parsed.series : [],
      currentMrr: typeof parsed.currentMrr === "number" ? parsed.currentMrr : 0,
    };
  } catch (err) {
    throw new BillingError(res.status, `getGrossBillable parse: ${(err as Error).message}`, text);
  }
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
  // Legacy 4.0 custom-priced plans carry the price IN the account_type string
  // ("Automatic Web $120", "Automatic Web $135" — Aurora ACCOUNT_TYPE, synced
  // verbatim). Strip a trailing $-amount so those resolve to their base tier:
  // they ARE paying plans (treating them as unknown made every plan change
  // look like a Trial conversion — wrong converted_at stamp + a spurious
  // feed-provider gate — and made cascades silently skip their billing line).
  // The custom PRICE itself lives on the 4.0/FreshBooks side only; da-billing
  // lines always bill at the canonical tier rate.
  const a = accountType.trim().toLowerCase().replace(/\s*\$\s*\d+(?:\.\d{1,2})?$/, "");
  if (a === "manual" || a === "monthly subscription manual" || a === "sub-manual") {
    return SUBSCRIPTION_TIERS["sub-manual"];
  }
  if (
    a === "automatic web" || a === "automatic_web" || a === "auto-web" ||
    a === "monthly subscription automatic web" || a === "sub-auto-web"
  ) {
    return SUBSCRIPTION_TIERS["sub-auto-web"];
  }
  if (
    a === "automatic dms" || a === "automatic_dms" || a === "auto-dms" ||
    a === "monthly subscription automatic dms" || a === "sub-auto-dms"
  ) {
    return SUBSCRIPTION_TIERS["sub-auto-dms"];
  }
  return null;
}

/**
 * Today's date as an ISO date string (YYYY-MM-DD) — the nextInvoiceDate for a
 * fresh subscription template. A dealer upgrading from Free to a paid plan is
 * billed on the upgrade date (today), and that day-of-month becomes the
 * recurring billing date — da-billing's cron generates the first invoice on the
 * next run and then rolls the date forward monthly, preserving the day-of-month.
 * (Previously this was first-of-next-month, which skipped billing the upgrade
 * month and moved every dealer's billing day to the 1st.)
 */
export function todayIso(now: Date = new Date()): string {
  // Today's calendar date in America/New_York (the billing business timezone),
  // not UTC — a late-evening ET upgrade must bill "today" in ET, and a bare UTC
  // date would both roll to tomorrow and mis-display by a day. en-CA gives ISO
  // YYYY-MM-DD ordering.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

// Friendly subscription-tier label for an account_type — mirrors the Dealers
// list's SUBSCRIPTION_LABELS so both surfaces read identically ("Automatic
// Web", "Manual", "Automatic DMS", "Trial", else "Free"). Strips the legacy
// " $price" suffix. Used by the billing views (incl. group-billed dealers).
const SUBSCRIPTION_TIER_LABELS: Record<string, string> = {
  "sub-manual": "Manual",
  "sub-auto-web": "Automatic Web",
  "sub-auto-dms": "Automatic DMS",
  "Manual": "Manual",
  "Automatic Web": "Automatic Web",
  "Automatic DMS": "Automatic DMS",
  "Monthly Subscription Manual": "Manual",
  "Monthly Subscription Automatic Web": "Automatic Web",
  "Monthly Subscription Automatic DMS": "Automatic DMS",
  "Trial": "Trial",
};

export function subscriptionTierLabel(accountType: string | null | undefined): string {
  if (!accountType) return "Free";
  const trimmed = accountType.split(" $")[0].trim();
  return SUBSCRIPTION_TIER_LABELS[trimmed] ?? "Free";
}

// ── Fleet billing summary (super_admin Billing mini-dashboard) ───────────────
// GET /reports/summary on da-billing — mrr is the same run-rate the BI tab's
// gross-billable call reports; past_due uses the billing-status print-lock
// aging per customer. Cached in-module for 5 minutes (same idiom as the
// pricing cache above); returns null on ANY failure — misconfigured key,
// network error, non-200, bad shape — so the Billing page renders a degraded
// "open da-billing directly" state instead of erroring. Never throws.

export interface BillingSummary {
  mrr: number;
  active_customers: number;
  setup_mode_customers: number;
  past_due: { count: number; outstanding_total: number };
  invoices_this_month: { generated: number; sent: number; paid: number };
}

let summaryCache: { fetchedAt: number; summary: BillingSummary } | null = null;
const SUMMARY_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function getBillingSummary(): Promise<BillingSummary | null> {
  const now = Date.now();
  if (summaryCache && now - summaryCache.fetchedAt < SUMMARY_TTL_MS) {
    return summaryCache.summary;
  }
  if (!billingConfigured()) return null;
  try {
    const res = await fetch(`${BASE}/reports/summary`, {
      headers: authHeaders(),
      cache: "no-store", // module cache above owns freshness
      signal: AbortSignal.timeout(5000), // page must render even if da-billing hangs
    });
    if (!res.ok) return null;
    const data = (await res.json()) as BillingSummary;
    if (
      typeof data?.mrr !== "number" ||
      typeof data?.past_due?.count !== "number" ||
      typeof data?.invoices_this_month?.generated !== "number"
    ) {
      return null;
    }
    summaryCache = { fetchedAt: now, summary: data };
    return data;
  } catch {
    return null;
  }
}

// ── Payments received by period (Billing page card) ──────────────────────────
// GET /reports/payments-by-period?month=YYYY-MM on da-billing — the month's
// payments bucketed 1–7 / 8–14 / 15–21 / 22–EOM by the day the money was
// RECEIVED (invoice.paidAt), day boundaries in America/New_York (the billing
// business timezone the invoice cron already runs on). Net of refunds, which
// da-billing buckets by refundedAt. No money math here — da-billing owns it.
//
// Cached per month for 5 minutes, same idiom as getBillingSummary. Returns
// null on ANY failure so the Billing page degrades to a notice instead of
// erroring. Never throws.

export interface PaymentsPeriodBucket {
  key: string;
  label: string;
  start_day: number;
  end_day: number;
  gross: number;
  refunds: number;
  net: number;
  payment_count: number;
  refund_count: number;
}

export interface PaymentsByPeriod {
  month: string;
  timezone: string;
  buckets: PaymentsPeriodBucket[];
  total: {
    gross: number;
    refunds: number;
    net: number;
    payment_count: number;
    refund_count: number;
  };
}

const paymentsCache = new Map<string, { fetchedAt: number; data: PaymentsByPeriod }>();

export async function getPaymentsByPeriod(month: string): Promise<PaymentsByPeriod | null> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  const now = Date.now();
  const hit = paymentsCache.get(month);
  if (hit && now - hit.fetchedAt < SUMMARY_TTL_MS) return hit.data;
  if (!billingConfigured()) return null;
  try {
    const res = await fetch(`${BASE}/reports/payments-by-period?month=${encodeURIComponent(month)}`, {
      headers: authHeaders(),
      cache: "no-store", // module cache above owns freshness
      signal: AbortSignal.timeout(5000), // page must render even if da-billing hangs
    });
    if (!res.ok) return null;
    const data = (await res.json()) as PaymentsByPeriod;
    if (!Array.isArray(data?.buckets) || data.buckets.length !== 4 || typeof data?.total?.net !== "number") {
      return null;
    }
    paymentsCache.set(month, { fetchedAt: now, data });
    return data;
  } catch {
    return null;
  }
}
