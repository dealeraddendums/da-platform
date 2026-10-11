const MANDRILL_API = 'https://mandrillapp.com/api/1.0';

interface MandrillRecipient {
  email: string;
  name?: string;
  type?: 'to' | 'cc' | 'bcc';
}

interface MandrillAttachment {
  /** MIME type, e.g. "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" */
  type: string;
  /** Filename including extension as shown to the recipient. */
  name: string;
  /** Base64-encoded file contents (no data: prefix). */
  content: string;
}

interface MandrillMessage {
  html: string;
  subject: string;
  from_email: string;
  from_name?: string;
  to: MandrillRecipient[];
  /** Optional attachments (passed through to Mandrill's attachments[] field). */
  attachments?: MandrillAttachment[];
  /**
   * Mandrill click-tracking. Defaults to FALSE for every send — see the note
   * in sendMandrillEmail. Only set this true for a genuinely promotional send.
   */
  track_clicks?: boolean;
  /** Mandrill open-tracking (pixel only — never rewrites a link). Left on. */
  track_opens?: boolean;
  /** Extra headers — Mandrill accepts only Reply-To and X-* here. */
  headers?: Record<string, string>;
}

interface MandrillSendResult {
  email: string;
  status: 'sent' | 'queued' | 'scheduled' | 'rejected' | 'invalid';
  reject_reason?: string | null;
}

export async function sendMandrillEmail(message: MandrillMessage): Promise<void> {
  const apiKey = process.env.MANDRILL_API_KEY;
  if (!apiKey) {
    console.warn('[mandrill] MANDRILL_API_KEY not set — email not sent to', message.to[0]?.email);
    return;
  }
  const res = await fetch(`${MANDRILL_API}/messages/send.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // track_clicks is FIRST so an explicit per-message value still wins.
    //
    // Click tracking rewrites every href into https://mandrillapp.com/track/click/…
    // before the recipient ever sees it. Dealership networks routinely run DNS
    // filtering that blocks third-party click redirectors, so that host answers
    // NXDOMAIN on their machine while resolving fine everywhere else — the link
    // is dead for exactly the people we sent it to, and looks healthy to us.
    // Every email this helper sends is transactional (invites, codes, invoices,
    // alerts): the link IS the payload, and a redirector that can be blocked is
    // a single point of failure we get nothing for. Click analytics are not
    // worth a migration invite or a Pay link that cannot be opened.
    body: JSON.stringify({ key: apiKey, message: { track_clicks: false, ...message } }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Mandrill error ${res.status}: ${text}`);
  }

  // Mandrill returns HTTP 200 even when a recipient is NOT delivered: the body
  // is a per-recipient array [{ email, status, reject_reason }] where status can
  // be "rejected" (hard-bounce / denylist / spam / unsub) or "invalid". Treating
  // those as success is how non-deliveries silently looked "sent" platform-wide.
  // Parse the body and throw so every caller can surface the real outcome.
  const body = await res.json().catch(() => null) as MandrillSendResult[] | { status?: string; message?: string } | null;

  if (Array.isArray(body)) {
    const failed = body.filter((r) => r.status === 'rejected' || r.status === 'invalid');
    if (failed.length > 0) {
      const detail = failed
        .map((r) => `${r.email}: ${r.status}${r.reject_reason ? ` (${r.reject_reason})` : ''}`)
        .join('; ');
      throw new Error(`Mandrill did not deliver — ${detail}`);
    }
  } else if (body && typeof body === 'object' && 'status' in body && body.status === 'error') {
    // Mandrill API-level error returned with HTTP 200.
    throw new Error(`Mandrill error: ${body.message ?? 'unknown'}`);
  }
}

// ── Deliverability ──────────────────────────────────────────────────────────
// Used by the Force Migration queue: forcing a dealer whose email bounces locks
// them out of BOTH platforms (4.0 redirects them away, and they can't receive
// the sign-in code for 5.0). A CONFIRMED denylist hit blocks the force; an
// UNKNOWN result (Mandrill unreachable / rate-limited) is advisory only
// (Allan, 2026-10-11) — the operator sees "couldn't verify" and may still force.
//
// Mandrill's denylist (`/rejects/list.json`) is the authoritative "we cannot
// deliver here" signal — hard bounces, spam complaints and manual blocks all
// land there. An address absent from it is deliverable as far as we know.
//
// Rate limiting (2026-10-11): the queue used to make one rejects/list call per
// recipient per render, which tripped Mandrill's HTTP 429 and turned whole
// queues "unconfirmed". Now the WHOLE denylist (133 active entries at the time;
// Mandrill returns up to 1000 per call) is fetched once and cached for
// DENYLIST_TTL_MS per worker, with one in-flight fetch shared by concurrent
// callers and one jittered retry on 429/5xx. If that fetch fails, every check
// answers "unknown" (no per-address retries — they'd rebuild the storm). Only
// if the list reaches Mandrill's 1000-row cap (possibly truncated) do lookups
// fall back to the per-address call (also cached, also retried).

export type DeliverabilityState = "ok" | "bounced" | "unknown";

export interface DeliverabilityResult {
  state: DeliverabilityState;
  /** Mandrill reject reason (hard-bounce / spam / unsub / custom), when denylisted. */
  reason?: string;
  detail?: string;
}

type RejectEntry = { email?: string; reason?: string; detail?: string; expired?: boolean };

const DENYLIST_TTL_MS = 5 * 60_000;
const DENYLIST_CAP = 1000;
type Denylist = { byEmail: Map<string, RejectEntry> | null; truncated?: boolean; error?: string };
let denylistCache: ({ at: number } & Denylist) | null = null;
let denylistInflight: Promise<Denylist> | null = null;
const perEmailCache = new Map<string, { at: number; result: DeliverabilityResult }>();

/** One rejects/list POST with a single jittered retry on 429 / 5xx / network error. */
async function rejectsList(body: Record<string, unknown>): Promise<{ ok: true; list: RejectEntry[] } | { ok: false; detail: string }> {
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1000 + Math.floor(Math.random() * 2000)));
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 10_000);
      let res: Response;
      try {
        res = await fetch(`${MANDRILL_API}/rejects/list.json`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally { clearTimeout(t); }
      if (res.status === 429 || res.status >= 500) { last = `Mandrill rejects/list HTTP ${res.status}`; continue; }
      if (!res.ok) return { ok: false, detail: `Mandrill rejects/list HTTP ${res.status}` };
      const parsed = await res.json().catch(() => null) as RejectEntry[] | { status?: string; message?: string } | null;
      if (!Array.isArray(parsed)) {
        const msg = parsed && typeof parsed === "object" && "message" in parsed ? String(parsed.message) : "unexpected response";
        return { ok: false, detail: `Mandrill: ${msg}` };
      }
      return { ok: true, list: parsed };
    } catch (e) {
      last = `Mandrill unreachable: ${e instanceof Error && e.name === "AbortError" ? "timed out" : e instanceof Error ? e.message : String(e)}`;
    }
  }
  return { ok: false, detail: last || "Mandrill unreachable" };
}

/** The whole active denylist, cached. byEmail=null + truncated → per-address
 *  lookups; byEmail=null + error → Mandrill unavailable (every check "unknown"). */
async function getDenylist(apiKey: string): Promise<Denylist> {
  if (denylistCache && Date.now() - denylistCache.at < (denylistCache.byEmail ? DENYLIST_TTL_MS : 30_000)) return denylistCache;
  if (denylistInflight) return denylistInflight;
  denylistInflight = (async () => {
    const r = await rejectsList({ key: apiKey, include_expired: false });
    let out: Denylist;
    if (!r.ok) out = { byEmail: null, error: r.detail };
    else if (r.list.length >= DENYLIST_CAP) out = { byEmail: null, truncated: true };
    else out = { byEmail: new Map(r.list.filter((e) => !e.expired && e.email).map((e) => [String(e.email).toLowerCase(), e])) };
    // A failed fetch is cached briefly (30s) so a rate-limited Mandrill isn't hammered.
    denylistCache = { at: Date.now(), ...out };
    return out;
  })().finally(() => { denylistInflight = null; });
  return denylistInflight;
}

/**
 * Is this address on Mandrill's denylist? Expired entries are ignored (Mandrill
 * ages soft failures out). Returns "unknown" — never "ok" — when Mandrill is
 * unreachable or unconfigured, so a transient API failure is never mistaken for
 * a clean bill of health (the caller shows it as "couldn't verify").
 */
export async function checkDeliverability(email: string): Promise<DeliverabilityResult> {
  const apiKey = process.env.MANDRILL_API_KEY;
  if (!apiKey) return { state: "unknown", detail: "MANDRILL_API_KEY not set" };
  const addr = (email ?? "").trim().toLowerCase();
  if (!addr) return { state: "unknown", detail: "no email address" };

  const list = await getDenylist(apiKey);
  if (list.byEmail) {
    const hit = list.byEmail.get(addr);
    return hit ? { state: "bounced", reason: hit.reason ?? "denylisted", detail: hit.detail ?? undefined } : { state: "ok" };
  }

  // Mandrill unavailable (rate-limited / down): answer "unknown" for everyone
  // from the one failed fetch — per-address retries would rebuild the 429 storm.
  if (!list.truncated) return { state: "unknown", detail: list.error ?? "Mandrill unavailable" };

  // List possibly truncated at the 1000-row cap: per-address lookup, cached.
  const cached = perEmailCache.get(addr);
  if (cached && Date.now() - cached.at < (cached.result.state === "unknown" ? 30_000 : DENYLIST_TTL_MS)) return cached.result;
  const r = await rejectsList({ key: apiKey, email: addr, include_expired: false });
  let result: DeliverabilityResult;
  if (!r.ok) result = { state: "unknown", detail: r.detail };
  else {
    const hit = r.list.find((e) => !e.expired && (e.email ?? "").toLowerCase() === addr);
    result = hit ? { state: "bounced", reason: hit.reason ?? "denylisted", detail: hit.detail ?? undefined } : { state: "ok" };
  }
  perEmailCache.set(addr, { at: Date.now(), result });
  return result;
}
