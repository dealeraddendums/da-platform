// Phase 14 — HubSpot one-way sync client.
//
// Pure write path: DA Platform pushes Company / Contact updates to HubSpot
// CRM. We never read records FROM HubSpot to update Supabase — the
// platform is the single source of truth. Internal names (`platformid`,
// `lifecyclestage` numeric IDs, etc.) were confirmed against portal
// 23896347 on 2026-05-31; see CLAUDE-da-platform.md Phase 14 for the
// confirmation log.
//
// Auth is a private-app token (HUBSPOT_PRIVATE_APP_TOKEN, Bearer). No
// OAuth flow, no inbound webhooks, no client secret needed.

const BASE = "https://api.hubapi.com/crm/v3";

export function hubspotConfigured(): boolean {
  return Boolean(process.env.HUBSPOT_PRIVATE_APP_TOKEN);
}

function authHeaders(extra: Record<string, string> = {}): HeadersInit {
  const tok = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!tok) throw new Error("HUBSPOT_PRIVATE_APP_TOKEN not set");
  return { Authorization: `Bearer ${tok}`, ...extra };
}

class HubspotError extends Error {
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

// ── Lifecycle stage internal values (confirmed via /properties/companies/lifecyclestage) ──

export const LIFECYCLE = {
  /** Default HubSpot stage — readable. Used on upgrade (paying account). */
  CUSTOMER:           "customer",
  /** Custom stage. Individual dealer that started on Free/Trial. */
  DEALER_TRIAL:       "60435067",
  /** Custom stage. Group or reseller that started on Free/Trial. */
  GROUP_TRIAL:        "60429213",
  /** Custom stage. Past 30d or 30 prints since trial start. */
  TRIAL_EXPIRED:      "65495635",
  /** Custom stage. Operator-flagged pause. */
  ACCOUNT_PAUSED:     "78548766",
  /** Custom stage. Operator-flagged downgrade. */
  ACCOUNT_DOWNGRADED: "108387744",
} as const;

// ── Plan-tier mapping (dealer.account_type → subscription_type enum) ──

const SUBSCRIPTION_TYPE_MAP: Record<string, string> = {
  "Manual":          "Manual",
  "Automatic Web":   "Auto-Web",
  "Automatic DMS":   "Auto-DMS",
  "Free":            "Free",
  "Trial":           "Trial",
  "PAYGo":           "PAYGo",
  // New-platform slugs that snuck into the data
  "sub-manual":      "Manual",
  "sub-auto-web":    "Auto-Web",
  "sub-auto-dms":    "Auto-DMS",
};

/**
 * Coerce dealer.account_type to the HubSpot subscription_type enum
 * value. Handles legacy "Automatic Web $135" style price suffixes by
 * stripping anything past the first " $". Returns null when the tier
 * is unrecognized (so the property gets omitted rather than rejected).
 */
export function normalizeSubscriptionType(accountType: string | null | undefined): string | null {
  if (!accountType) return null;
  const trimmed = accountType.split(" $")[0].trim();
  return SUBSCRIPTION_TYPE_MAP[trimmed] ?? null;
}

/**
 * "Paying" determinant — non-trial-class account_type counts as
 * Customer. Aligns with how labels-billing eligibility is gated today.
 */
export function isPayingAccount(accountType: string | null | undefined): boolean {
  if (!accountType) return false;
  const normalized = normalizeSubscriptionType(accountType);
  if (!normalized) return false;
  return normalized !== "Free" && normalized !== "Trial";
}

// ── Wire types — minimal shape the sync code needs ──

type CompanyProperties = Record<string, string | number | null | undefined>;

interface HubspotObject {
  id: string;
  properties: Record<string, string | null>;
}

interface SearchResponse {
  results: HubspotObject[];
  total: number;
}

// ── Generic CRUD ────────────────────────────────────────────────────────────

/**
 * Search by a single property exact-match. Returns the first hit or
 * null. Used by upsert fallback path 2 (row has no hubspot_*_id stored
 * but HubSpot may already have a record matching our key, e.g.
 * platformid=qa-test-dealer-a).
 */
async function searchByProperty(
  object: "companies" | "contacts",
  propertyName: string,
  value: string,
): Promise<HubspotObject | null> {
  const res = await fetch(`${BASE}/objects/${object}/search`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName, operator: "EQ", value }] }],
      limit: 1,
    }),
  });
  if (!res.ok) {
    throw new HubspotError(res.status, `search ${object} ${res.status}`, await readBody(res));
  }
  const parsed = await res.json() as SearchResponse;
  return parsed.results?.[0] ?? null;
}

async function createObject(
  object: "companies" | "contacts",
  properties: CompanyProperties,
): Promise<HubspotObject> {
  const res = await fetch(`${BASE}/objects/${object}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ properties }),
  });
  if (res.status === 409) {
    // 409 = "Contact already exists". Pull the existing id from the
    // error body, then PATCH against it. HubSpot's 409 response embeds
    // the existing record's id in `message` or `errors[0].id`.
    const text = await readBody(res);
    const idMatch = text.match(/Existing ID:\s*(\d+)/i) ?? text.match(/"existing_object_id":\s*"?(\d+)"?/);
    if (idMatch) {
      return updateObject(object, idMatch[1], properties);
    }
    throw new HubspotError(409, `create ${object} 409 with no id`, text);
  }
  if (!res.ok) {
    throw new HubspotError(res.status, `create ${object} ${res.status}`, await readBody(res));
  }
  return res.json() as Promise<HubspotObject>;
}

async function updateObject(
  object: "companies" | "contacts",
  hubspotId: string,
  properties: CompanyProperties,
): Promise<HubspotObject> {
  const res = await fetch(`${BASE}/objects/${object}/${encodeURIComponent(hubspotId)}`, {
    method: "PATCH",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) {
    throw new HubspotError(res.status, `update ${object}/${hubspotId} ${res.status}`, await readBody(res));
  }
  return res.json() as Promise<HubspotObject>;
}

// ── Three-stage idempotent upsert ────────────────────────────────────────────

/**
 * Three-stage idempotent upsert:
 *   (1) `existingHubspotId` known → PATCH directly.
 *   (2) Search by `searchProperty`/`searchValue` → PATCH the hit + caller
 *       persists the id back to the Supabase row.
 *   (3) Neither → POST create + caller persists the id.
 *
 * Returns the HubSpot id and a flag for whether it was created (so the
 * caller knows whether to write the id back to Supabase).
 */
export async function upsertObject(args: {
  object: "companies" | "contacts";
  properties: CompanyProperties;
  existingHubspotId: string | null;
  searchProperty: string;
  searchValue: string | null;
}): Promise<{ hubspotId: string; created: boolean }> {
  // Strip null/undefined values — HubSpot rejects null on enumerations
  // and treats empty string as "set to empty" which clobbers operator
  // edits.
  const clean: CompanyProperties = {};
  for (const [k, v] of Object.entries(args.properties)) {
    if (v === null || v === undefined || v === "") continue;
    clean[k] = v;
  }

  // (1) PATCH by known id.
  if (args.existingHubspotId) {
    const updated = await updateObject(args.object, args.existingHubspotId, clean);
    return { hubspotId: updated.id, created: false };
  }

  // (2) Search by natural key.
  if (args.searchValue) {
    const found = await searchByProperty(args.object, args.searchProperty, args.searchValue);
    if (found) {
      const updated = await updateObject(args.object, found.id, clean);
      return { hubspotId: updated.id, created: true /* caller writes id back */ };
    }
  }

  // (3) Create.
  const created = await createObject(args.object, clean);
  return { hubspotId: created.id, created: true };
}
