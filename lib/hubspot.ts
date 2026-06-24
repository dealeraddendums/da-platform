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

/**
 * Create a Note (engagement) and associate it to a Contact and (optionally) a
 * Company. Used to log a full Help conversation transcript on close — one note
 * per conversation, not per message. Throws on failure (caller logs to
 * hubspot_sync_errors). Default HubSpot association type ids: note→contact 202,
 * note→company 190.
 */
export async function createConversationNote(args: {
  contactId: string;
  companyId?: string | null;
  body: string;
}): Promise<{ id: string }> {
  const associations: unknown[] = [
    { to: { id: args.contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] },
  ];
  if (args.companyId) {
    associations.push({ to: { id: args.companyId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 190 }] });
  }
  const res = await fetch(`${BASE}/objects/notes`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      properties: { hs_timestamp: new Date().toISOString(), hs_note_body: args.body.slice(0, 65000) },
      associations,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new HubspotError(res.status, `createConversationNote ${res.status}`, text);
  return { id: (JSON.parse(text) as { id: string }).id };
}

/**
 * Update an existing conversation Note's body (upsert path — captures
 * reopen-and-continue without creating a second note). Associations are
 * unchanged; we only refresh hs_note_body. Throws on failure.
 */
export async function updateConversationNote(noteId: string, body: string): Promise<void> {
  const res = await fetch(`${BASE}/objects/notes/${encodeURIComponent(noteId)}`, {
    method: "PATCH",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ properties: { hs_note_body: body.slice(0, 65000) } }),
  });
  if (!res.ok) throw new HubspotError(res.status, `updateConversationNote ${noteId} ${res.status}`, await readBody(res));
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

/**
 * Thrown by upsertObject's pre-create dedup guard. Signals that the
 * caller was about to create a duplicate of an existing unlinked
 * HubSpot record (e.g. the original company an operator created
 * manually, or one carried over from the dead legacy sync, that lacks
 * our `platformid` / `groupid`). The caller catches this, logs it as
 * a `dedup-skip`, and alerts a human to merge by hand. See
 * docs/hubspot-dedup-cleanup.md (the 2026-05-31 cleanup plan).
 */
export class DedupSkipError extends Error {
  unlinkedOriginalId: string;
  matchedOn: string;
  constructor(unlinkedOriginalId: string, matchedOn: string) {
    super(`dedup-skip: would create a duplicate of unlinked HubSpot id ${unlinkedOriginalId} (matched on ${matchedOn})`);
    this.unlinkedOriginalId = unlinkedOriginalId;
    this.matchedOn = matchedOn;
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

// ── source_form OPTION VALUES (Company) ───────────────────────────────────────
// Set ON CREATE ONLY, keyed by the creation path. NOTE: the API value differs
// from the dropdown label for the two dealer-add paths (the value carries a
// "New " prefix the label hides). Confirmed against portal 23896347 2026-06-07
// via /properties/companies/source_form.
export const SOURCE_FORM = {
  /** Marketing-OS self-serve signup (dealer or group). */
  SELF_SERVE:      "DA Mktg OS",
  /** Operator-created standalone dealer (POST /api/dealers, super_admin). */
  DEALER_BY_ADMIN: "New Dealer Add by DA Admin",
  /** group_admin-created member dealer (POST /api/dealers, group_admin). */
  DEALER_BY_GROUP: "New Dealer Add by Group",
  /** Operator-created group (POST /api/groups). */
  GROUP_BY_ADMIN:  "Group Add by DA Admin",
} as const;

// ── industry OPTION VALUES (Company) — set ON CREATE ONLY, by entity type ──────
// Custom options appended to the standard HubSpot `industry` enum; value==label.
export const INDUSTRY = {
  DEALER:   "Automotive Dealer",
  GROUP:    "Automotive Dealer Group",
  RESELLER: "Reseller",
} as const;

const V4_BASE = "https://api.hubapi.com/crm/v4";

/**
 * Associate a Contact to a Company using the default HubSpot association type
 * (v4 "default" endpoint — no type id needed, creates the standard
 * contact↔company link in both directions). Idempotent: PUT re-asserts the
 * same default label without duplicating, so it's safe to call on every sync.
 * Throws on failure (caller logs/swallows).
 */
export async function associateContactToCompany(contactId: string, companyId: string): Promise<void> {
  const res = await fetch(
    `${V4_BASE}/objects/contacts/${encodeURIComponent(contactId)}/associations/default/companies/${encodeURIComponent(companyId)}`,
    { method: "PUT", headers: authHeaders({ "Content-Type": "application/json" }) },
  );
  if (!res.ok) {
    throw new HubspotError(res.status, `associateContactToCompany ${contactId}->${companyId} ${res.status}`, await readBody(res));
  }
}

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

/**
 * Pre-create dedup probe — look up a HubSpot Company that matches by
 * exact name + phone but **doesn't** carry our own-key (`platformid`
 * for dealers, `groupid` for groups). A hit means: an unlinked
 * original exists, and creating a new record now would make a
 * duplicate. The upsert path uses this between stage 2 (search by own
 * key) and stage 3 (create) — see upsertObject.dedupCheck.
 *
 * Strict by design: returns null when name or phone is empty, and
 * matches phone exactly (no digits-only normalization). Format
 * mismatches will miss; that's a safe failure mode — the dedup script
 * catches what the guard misses, and false-positive create-refusals
 * are more costly than false-negative ones.
 */
export async function findUnlinkedOriginal(args: {
  name: string | null;
  phone: string | null;
  ownKey: "platformid" | "groupid";
}): Promise<{ id: string; matchedOn: string } | null> {
  if (!args.name || !args.phone) return null;
  const res = await fetch(`${BASE}/objects/companies/search`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      filterGroups: [{ filters: [
        { propertyName: "name",      operator: "EQ", value: args.name },
        { propertyName: "phone",     operator: "EQ", value: args.phone },
        { propertyName: args.ownKey, operator: "NOT_HAS_PROPERTY" },
      ]}],
      limit: 1,
    }),
  });
  if (!res.ok) {
    throw new HubspotError(res.status, `findUnlinkedOriginal ${res.status}`, await readBody(res));
  }
  const parsed = await res.json() as SearchResponse;
  const hit = parsed.results?.[0];
  if (!hit) return null;
  return { id: hit.id, matchedOn: `name+phone, no ${args.ownKey}` };
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
  /**
   * Optional pre-create dedup hook. Called only on the path
   * "no stored id (or stale) AND no natural-key hit AND about to
   * create". A non-null return throws DedupSkipError so the caller
   * can log + alert instead of manufacturing a duplicate.
   */
  dedupCheck?: () => Promise<{ id: string; matchedOn: string } | null>;
  /**
   * Properties applied ONLY when this call actually POSTs a brand-new object
   * (stage 3) — never on a PATCH of an existing/stored record. Use for fields
   * that are stamped at creation and must not clobber later operator edits
   * (source_form, industry). An existing record found by stored id or natural
   * key is left untouched for these.
   */
  createOnlyProperties?: CompanyProperties;
  /**
   * Refresh-only paths (e.g. the nightly computed-fields cron) set this so the
   * function NEVER creates a new object. If the stored id 404s AND the natural
   * key search misses, it throws HubspotNoExistingObjectError instead of POSTing
   * a half-populated record. Prevents the daily blank-company bug: the cron's
   * payload is computed fields only (no name/platformid), so a create-fallthrough
   * for a dealer whose company was deleted in HubSpot manufactured a blank.
   */
  updateOnly?: boolean;
}): Promise<{ hubspotId: string; created: boolean }> {
  // Strip null/undefined values — HubSpot rejects null on enumerations
  // and treats empty string as "set to empty" which clobbers operator
  // edits.
  const strip = (src: CompanyProperties): CompanyProperties => {
    const out: CompanyProperties = {};
    for (const [k, v] of Object.entries(src)) {
      if (v === null || v === undefined || v === "") continue;
      out[k] = v;
    }
    return out;
  };
  const clean = strip(args.properties);
  const cleanCreateOnly = strip(args.createOnlyProperties ?? {});

  // (1) PATCH by known id. If the stored id 404s the record was
  //     deleted in HubSpot but Supabase didn't get the memo — fall
  //     through to search-by-key + create. Caller will see
  //     created=true and write the fresh id back over the stale one.
  if (args.existingHubspotId) {
    try {
      const updated = await updateObject(args.object, args.existingHubspotId, clean);
      return { hubspotId: updated.id, created: false };
    } catch (err) {
      if (!(err instanceof HubspotError) || err.status !== 404) throw err;
      console.warn(`[hubspot] stale ${args.object} id ${args.existingHubspotId} — falling through to search/create`);
    }
  }

  // (2) Search by natural key.
  if (args.searchValue) {
    const found = await searchByProperty(args.object, args.searchProperty, args.searchValue);
    if (found) {
      const updated = await updateObject(args.object, found.id, clean);
      return { hubspotId: updated.id, created: true /* caller writes id back */ };
    }
  }

  // (2.5) Dedup guard — refuse to create if an unlinked original
  //       already exists for the same identity. Only runs when stages 1+2
  //       didn't resolve, so the happy path (id stored OR own-key match)
  //       skips this entirely. Throws DedupSkipError up to the caller.
  if (args.dedupCheck) {
    const hit = await args.dedupCheck();
    if (hit) throw new DedupSkipError(hit.id, hit.matchedOn);
  }

  // Refresh-only caller: do NOT create. The stored id is stale (404) and no
  // natural-key match exists — the company was deleted in HubSpot. Creating from
  // a computed-only payload would manufacture a blank record. Signal the caller
  // to clear the stale id and skip (the backfill / event-driven path re-creates
  // it later with full data).
  if (args.updateOnly) {
    throw new HubspotNoExistingObjectError(args.object, args.searchValue);
  }

  // (3) Create. Create-only properties (source_form, industry) are merged in
  //     here ONLY — they never reach the PATCH paths above, so a re-sync of an
  //     existing record can't overwrite an operator's manual edit.
  const created = await createObject(args.object, { ...clean, ...cleanCreateOnly });
  return { hubspotId: created.id, created: true };
}

/** Thrown by upsertObject({ updateOnly: true }) when there's no existing object
 *  to update — so refresh paths never create a blank record. */
export class HubspotNoExistingObjectError extends Error {
  constructor(public objectType: string, public searchValue: string | null) {
    super(`No existing ${objectType} to update (updateOnly; searchValue=${searchValue ?? "null"})`);
    this.name = "HubspotNoExistingObjectError";
  }
}
