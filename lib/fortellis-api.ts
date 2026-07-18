// Server-only helpers for talking to Fortellis (CDK's API platform) — the
// replacement for the legacy CDK PIP extract (sunset 2026-10-23).
//
// Credentials live in .env.production; never let them reach the browser.
//
// API: "CDK Drive Get Merchandisable Vehicles v2" (MVS2) — a synchronous,
// paginated inventory search. Contract pinned from the authoritative MVS2
// Developer Guide + Field Mapping Guide (da-platform/docs/fortellis-samples/
// 06 + 07; see FINDINGS.md). Verified live: OAuth token + subscriptions. The
// vehicle search itself is unreachable in the current sandbox (Test
// subscription inactive + API restricted), so mapVehicle() is built to the
// guide's documented schema and is the single place to adjust if a field name
// differs on the first live call.
//
//   - OAuth 2.0 client-credentials, scope=anonymous, 1h Bearer tokens.
//   - Service URL: https://api.fortellis.io/{cdk|cdk-test}/sales/inventory/v2/merchandisable-vehicles
//   - GET /        vehicleSearchUsingGET → { summary:{totalCount,limit,offset}, results:[…] }
//   - GET /ping    connectivity probe
//   - Headers: Authorization, Subscription-Id, Request-Id (GUID). Accept/Accept-*
//     optional. Optional dealerCode header. NO Department-Id.
//   - Pagination: limit (max 100) + offset. Delta: modifiedTimeRange=<start>:<end>
//     (UTC YYYY-MM-DDThh:mm:ss.sssZ). Removals: deleted=true + per-record `deleted` bool.

import { createAdminSupabaseClient, fireWrite } from "@/lib/db";

// ── Config ───────────────────────────────────────────────────────────────────

const TOKEN_URL =
  process.env.FORTELLIS_TOKEN_URL ??
  "https://identity.fortellis.io/oauth2/aus1p1ixy7YL8cMq02p7/v1/token";
const API_KEY = process.env.FORTELLIS_API_KEY ?? "";
const API_SECRET = process.env.FORTELLIS_API_SECRET ?? "";
const API_BASE = (process.env.FORTELLIS_API_BASE ?? "https://api.fortellis.io").replace(/\/+$/, "");
// 'test' -> /cdk-test namespace, 'production' -> /cdk (per the MVS2 guide's service URL).
const FORTELLIS_ENV = (process.env.FORTELLIS_ENV ?? "test").toLowerCase();
// Path after the namespace. Overridable, but the guide fixes it to this.
const MV_PATH = (process.env.FORTELLIS_MV_PATH ?? "sales/inventory/v2/merchandisable-vehicles").replace(/^\/+|\/+$/g, "");
const SUBSCRIPTIONS_URL =
  process.env.FORTELLIS_SUBSCRIPTIONS_URL ??
  "https://subscriptions.fortellis.io/v1/solution/subscriptions";

const PAGE_SIZE = 100;          // MVS2 hard max per request
const MAX_PAGES = 500;          // safety backstop (50k vehicles/dealer)

export function fortellisConfigured(): boolean {
  return Boolean(API_KEY && API_SECRET);
}

function namespace(): string {
  return FORTELLIS_ENV === "production" || FORTELLIS_ENV === "prod" ? "cdk" : "cdk-test";
}

/** Base service URL, e.g. https://api.fortellis.io/cdk-test/sales/inventory/v2/merchandisable-vehicles */
export function mvBaseUrl(): string {
  return `${API_BASE}/${namespace()}/${MV_PATH}`;
}

// ── Errors ────────────────────────────────────────────────────────────────────

export type FortellisErrorType = "auth_401" | "no_supabase_dealer" | "timeout" | "token" | "network" | "server" | "other";

export class FortellisError extends Error {
  type: FortellisErrorType;
  httpStatus?: number;
  constructor(type: FortellisErrorType, message: string, httpStatus?: number) {
    super(message);
    this.type = type;
    this.httpStatus = httpStatus;
  }
}
export class FortellisAuthError extends FortellisError {
  constructor(message: string) { super("token", message); }
}

// ── Token manager (module-level cache, single-flight refresh) ─────────────────

interface CachedToken { token: string; expiresAt: number; }
let cachedToken: CachedToken | null = null;
let inflight: Promise<string> | null = null;

/**
 * Returns a valid Bearer token, refreshing at ~55 min. Concurrent callers share
 * one in-flight refresh. Throws FortellisAuthError on token-endpoint failure
 * (the availability state machine keys DOWN off this).
 */
export async function getToken(force = false): Promise<string> {
  const now = Date.now();
  if (!force && cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.token;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    if (!fortellisConfigured()) {
      throw new FortellisAuthError("FORTELLIS_API_KEY / FORTELLIS_API_SECRET not set");
    }
    const started = Date.now();
    const basic = Buffer.from(`${API_KEY}:${API_SECRET}`).toString("base64");
    let res: Response;
    try {
      res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
        // scope=anonymous is REQUIRED — the server 400s without a scope (Phase 0).
        body: "grant_type=client_credentials&scope=anonymous",
      });
    } catch (err) {
      logCall({ method: "POST", url: TOKEN_URL, requestHeaders: { Authorization: "Basic ####…" }, durationMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) });
      throw new FortellisAuthError(`Token request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const bodyText = await res.text();
    logCall({
      method: "POST", url: TOKEN_URL, httpStatus: res.status, durationMs: Date.now() - started,
      requestHeaders: { Authorization: "Basic ####…", "Content-Type": "application/x-www-form-urlencoded" },
      responseBody: bodyText.replace(/"access_token"\s*:\s*"[^"]+"/, '"access_token":"####…"'),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new FortellisAuthError(`Token endpoint HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
    }
    let parsed: { access_token?: string; expires_in?: number };
    try { parsed = JSON.parse(bodyText); } catch { throw new FortellisAuthError("Token endpoint returned non-JSON"); }
    if (!parsed.access_token) throw new FortellisAuthError("Token endpoint returned no access_token");
    cachedToken = { token: parsed.access_token, expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000 };
    return parsed.access_token;
  })().finally(() => { inflight = null; });
  return inflight;
}

// ── Certification logging ─────────────────────────────────────────────────────

export function maskAuth(value: string | undefined | null): string {
  if (!value) return "";
  const scheme = value.split(" ")[0] || "";
  return `${scheme} ####…`;
}

interface LogArgs {
  method: string;
  url: string;
  subscriptionId?: string | null;
  requestId?: string | null;
  httpStatus?: number;
  durationMs?: number;
  requestHeaders?: Record<string, string>;
  responseBody?: string;
  error?: string;
}

/** Fire-and-forget cert log write. Any Authorization header is masked before storage. */
export function logCall(args: LogArgs): void {
  const admin = createAdminSupabaseClient();
  const headers = { ...(args.requestHeaders ?? {}) };
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "authorization") headers[k] = maskAuth(headers[k]);
  }
  fireWrite(
    // fortellis_api_log is not in the generated Database types (new table) — cast like cdk_dealers.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (admin as any).from("fortellis_api_log").insert({
      subscription_id: args.subscriptionId ?? null,
      method: args.method,
      url: args.url,
      request_id: args.requestId ?? null,
      http_status: args.httpStatus ?? null,
      duration_ms: args.durationMs ?? null,
      request_headers: headers,
      response_body: args.responseBody ?? null,
      error: args.error ?? null,
    } as never),
    "fortellis_api_log",
  );
}

// ── Subscriptions ─────────────────────────────────────────────────────────────

export interface FortellisSubscription {
  subscriptionId: string;
  orgId?: string;
  orgName?: string;
  status?: string;
  environment?: string;
  activationDate?: string;
  deactivationDate?: string;
  dealerCodes?: Array<{ franchiseName?: string; manufacturerCode?: string }>;
  apiDmsInfo?: Array<Record<string, unknown>>;
}

/** List all Marketplace subscriptions for the DA app (Add-dealer picker + new-sub detection). */
export async function getSubscriptions(): Promise<FortellisSubscription[]> {
  const token = await getToken();
  const started = Date.now();
  const res = await fetch(SUBSCRIPTIONS_URL, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const bodyText = await res.text();
  logCall({
    method: "GET", url: SUBSCRIPTIONS_URL, httpStatus: res.status, durationMs: Date.now() - started,
    requestHeaders: { Authorization: maskAuth(`Bearer ${token}`), Accept: "application/json" },
    responseBody: bodyText.slice(0, 20_000),
  });
  if (res.status < 200 || res.status >= 300) throw new FortellisError("server", `Subscriptions HTTP ${res.status}`, res.status);
  try {
    const parsed = JSON.parse(bodyText) as { subscriptions?: FortellisSubscription[] };
    return parsed.subscriptions ?? [];
  } catch { return []; }
}

// ── Vehicle search (synchronous, paginated) ───────────────────────────────────

const CALL_TIMEOUT_MS = 30_000;

export interface DealerScope {
  subscriptionId: string;
  webId?: string | null;
  dealerCode?: string | null;
}

interface SearchOpts extends DealerScope {
  modifiedSince?: Date;   // sets modifiedTimeRange from this to now
  until?: Date;
  deleted?: boolean;      // include only deleted/removed records
  signal?: AbortSignal;
}

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
}

function scopeParams(opts: SearchOpts): URLSearchParams {
  const p = new URLSearchParams();
  if (opts.webId) p.set("webId", opts.webId);
  if (opts.dealerCode) p.set("dealerCode", opts.dealerCode);
  if (opts.deleted) p.set("deleted", "true");
  if (opts.modifiedSince) {
    const start = fmtMillisZ(opts.modifiedSince);
    const end = fmtMillisZ(opts.until ?? new Date());
    p.set("modifiedTimeRange", `${start}:${end}`);
  }
  return p;
}

async function searchPage(opts: SearchOpts, offset: number, rid: string): Promise<{ summary: { totalCount?: number; count?: number }; results: unknown[] }> {
  const token = await getToken();
  const params = scopeParams(opts);
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String(offset));
  const url = `${mvBaseUrl()}/?${params.toString()}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Subscription-Id": opts.subscriptionId,
    "Request-Id": rid,
    Accept: "application/json",
  };
  if (opts.dealerCode) headers["dealerCode"] = opts.dealerCode;

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: opts.signal });
  } catch (err) {
    const isAbort = (err as { name?: string })?.name === "AbortError";
    logCall({ method: "GET", url, subscriptionId: opts.subscriptionId, requestId: rid, durationMs: Date.now() - started, requestHeaders: { ...headers, Authorization: maskAuth(headers.Authorization) }, error: err instanceof Error ? err.message : String(err) });
    throw new FortellisError(isAbort ? "timeout" : "network", err instanceof Error ? err.message : String(err));
  }
  const body = await res.text();
  logCall({
    method: "GET", url, subscriptionId: opts.subscriptionId,
    requestId: res.headers.get("Request-Id") ?? res.headers.get("Fort-Request-Id") ?? rid,
    httpStatus: res.status, durationMs: Date.now() - started,
    requestHeaders: { ...headers, Authorization: maskAuth(headers.Authorization) },
    responseBody: body.length > 200_000 ? body.slice(0, 200_000) + "…[truncated]" : body,
  });
  if (res.status === 401) throw new FortellisError("auth_401", "Fortellis HTTP 401 (Unauthorized) — dealer may have unsubscribed on the Marketplace", 401);
  if (res.status < 200 || res.status >= 300) {
    throw new FortellisError(res.status >= 500 ? "server" : "other", `Fortellis HTTP ${res.status}: ${body.slice(0, 200)}`, res.status);
  }
  let parsed: { summary?: { totalCount?: number; count?: number }; results?: unknown[] };
  try { parsed = JSON.parse(body); } catch {
    // Some deployments return a bare array.
    try { const arr = JSON.parse(body); if (Array.isArray(arr)) return { summary: { totalCount: arr.length }, results: arr }; } catch { /* fall through */ }
    throw new FortellisError("other", "Search returned non-JSON");
  }
  return { summary: parsed.summary ?? {}, results: parsed.results ?? [] };
}

/**
 * Run a full paginated search and return every raw record. Honors a 30s outer
 * abort. `opts.signal` is combined with a hard timeout by the caller.
 */
export async function searchVehicles(opts: SearchOpts): Promise<unknown[]> {
  const rid = requestId();
  const out: unknown[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { summary, results } = await searchPage(opts, offset, rid);
    out.push(...results);
    const total = summary.totalCount ?? summary.count ?? results.length;
    offset += PAGE_SIZE;
    if (results.length < PAGE_SIZE || offset >= total) break;
  }
  return out;
}

/** One-shot search with a 30s hard timeout (for Test/ping and per-dealer calls). */
export async function searchWithTimeout(opts: Omit<SearchOpts, "signal">): Promise<unknown[]> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    return await searchVehicles({ ...opts, signal: controller.signal });
  } finally { clearTimeout(t); }
}

/** Cheap connectivity probe for the Test button + pre-run health check. */
export async function ping(scope: DealerScope): Promise<{ ok: boolean; count: number; error?: string; errorType?: FortellisErrorType }> {
  try {
    // A tiny first-page search is the cheapest real connectivity check.
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
    try {
      const rid = requestId();
      const { summary, results } = await searchPage({ ...scope, signal: controller.signal }, 0, rid);
      return { ok: true, count: summary.totalCount ?? summary.count ?? results.length };
    } finally { clearTimeout(t); }
  } catch (err) {
    if (err instanceof FortellisError) return { ok: false, count: 0, error: err.message, errorType: err.type };
    return { ok: false, count: 0, error: err instanceof Error ? err.message : String(err), errorType: "other" };
  }
}

/** True only for errors that indicate the API itself is unavailable (vs a client/config/auth error). */
export function isOutageErrorType(t: FortellisErrorType | undefined): boolean {
  return t === "network" || t === "server" || t === "timeout" || t === "token";
}

/** MVS2 modifiedTimeRange format: UTC ISO-8601 with milliseconds + Z. */
function fmtMillisZ(d: Date): string {
  return d.toISOString(); // already YYYY-MM-DDThh:mm:ss.sssZ
}

// ── Vehicle mapping (MVS2 results[] record → dealer_vehicles shape) ───────────

export interface FortellisVehicle {
  vin: string | null;
  stock_number: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  msrp: number | null;
  internet_price: string | null;
  mileage: number | null;
  ext_color: string | null;
  int_color: string | null;
  new_used: string | null;
  certified: string | null;
  body_style: string | null;
  date_in_stock: string | null;
  sold: boolean; // true when the record signals sold/removed/deleted
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pick(obj: any, ...paths: string[]): any {
  for (const p of paths) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cur: any = obj;
    let ok = true;
    for (const part of p.split(".")) {
      if (cur == null || typeof cur !== "object" || !(part in cur)) { ok = false; break; }
      cur = cur[part];
    }
    if (ok && cur != null && cur !== "") return cur;
  }
  return null;
}

function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Find an amount in a typed price array (financials.prices[] or mathbox priceLineItems[]). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function priceOfType(arr: any, types: string[]): number | null {
  if (!Array.isArray(arr)) return null;
  const wanted = types.map(t => t.toLowerCase());
  for (const row of arr) {
    const t = String(row?.type ?? "").toLowerCase();
    if (wanted.includes(t)) {
      const amt = toNum(row?.amount ?? row?.priceValue);
      if (amt != null) return amt;
    }
  }
  return null;
}

/**
 * Map a raw MVS2 `results[]` record to the dealer_vehicles insert shape.
 * Field paths follow the MVS2 Field Mapping Guide (sample 07); each has a
 * defensive fallback. This is the single place to adjust if a real payload
 * differs from the guide's documented example.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapVehicle(raw: any): FortellisVehicle {
  // condition/certified from top-level `category` (new|used|certified|demo)
  const category = String(pick(raw, "category") ?? "").toLowerCase();
  const isCertified = category === "certified";
  const isUsed = category === "used" || category === "demo";

  // sold/removed: SoldDate is NOT supported by MVS2 — use `deleted` bool + status.
  const deleted = pick(raw, "deleted");
  const marketable = pick(raw, "marketable");
  const invStatus = String(pick(raw, "vehicleStatus.inventoryStatus", "vehicleStatus.displayableInventoryStatus", "status") ?? "").toLowerCase();
  const sold = deleted === true || marketable === false || /sold|delet|remov|inactive/.test(invStatus);

  // pricing: financials.prices[] (only with includeAllPrices) then mathbox price line items.
  const finPrices = pick(raw, "financials.prices");
  const cashItems = pick(raw, "mathbox.cash.priceLineItems");
  const leaseItems = pick(raw, "mathbox.lease.priceLineItems");
  const msrp =
    priceOfType(finPrices, ["BASE_RETAIL", "RETAIL", "MSRP", "STICKER"]) ??
    priceOfType(cashItems, ["RetailPrice"]) ??
    priceOfType(leaseItems, ["RetailPrice"]);
  const advertised =
    priceOfType(finPrices, ["ADVERTISED", "SELLING", "INTERNET"]) ??
    priceOfType(cashItems, ["SalePrice"]) ??
    priceOfType(leaseItems, ["SalePrice"]);

  return {
    vin: (pick(raw, "vin") as string) ?? null,
    stock_number: (pick(raw, "stockNumber", "stockNo") as string) ?? null,
    year: toNum(pick(raw, "year")),
    make: (pick(raw, "make", "makeName") as string) ?? null,
    model: (pick(raw, "model", "modelName") as string) ?? null,
    trim: (pick(raw, "trim", "originalTrim", "trimLevel") as string) ?? null,
    msrp,
    internet_price: advertised == null ? null : String(advertised),
    mileage: toNum(pick(raw, "odometer.value", "mileage")),
    ext_color: (pick(raw, "color.exterior.baseColor", "color.exterior.name", "color.baseColor") as string) ?? null,
    int_color: (pick(raw, "color.interior.baseColor", "color.interior.name") as string) ?? null,
    new_used: isUsed ? "Used" : "New",
    certified: isCertified ? "Y" : null,
    body_style: (pick(raw, "bodyStyleDescription", "bodyStyleClassification", "bodyType") as string) ?? null,
    date_in_stock: strOrNull(pick(raw, "createdDate", "lotDate")),
    sold,
  };
}

function strOrNull(v: unknown): string | null {
  if (v == null || v === "") return null;
  return String(v);
}
