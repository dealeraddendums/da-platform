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
// the sign-in code for 5.0). So "can we actually reach this address" is a hard
// gate on the force, not a warning.
//
// Mandrill's denylist (`/rejects/list.json`) is the authoritative "we cannot
// deliver here" signal — hard bounces, spam complaints and manual blocks all
// land there. An address absent from it is deliverable as far as we know.

export type DeliverabilityState = "ok" | "bounced" | "unknown";

export interface DeliverabilityResult {
  state: DeliverabilityState;
  /** Mandrill reject reason (hard-bounce / spam / unsub / custom), when denylisted. */
  reason?: string;
  detail?: string;
}

/**
 * Is this address on Mandrill's denylist? Expired entries are ignored (Mandrill
 * ages soft failures out). Returns "unknown" — never "ok" — when Mandrill is
 * unreachable or unconfigured, so a transient API failure can never be mistaken
 * for a clean bill of health and let a force through.
 */
export async function checkDeliverability(email: string): Promise<DeliverabilityResult> {
  const apiKey = process.env.MANDRILL_API_KEY;
  if (!apiKey) return { state: "unknown", detail: "MANDRILL_API_KEY not set" };
  const addr = (email ?? "").trim();
  if (!addr) return { state: "unknown", detail: "no email address" };

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10_000);
    let res: Response;
    try {
      res = await fetch(`${MANDRILL_API}/rejects/list.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: apiKey, email: addr, include_expired: false }),
        signal: controller.signal,
      });
    } finally { clearTimeout(t); }

    if (!res.ok) return { state: "unknown", detail: `Mandrill rejects/list HTTP ${res.status}` };
    const body = await res.json().catch(() => null) as Array<{ email?: string; reason?: string; detail?: string; expired?: boolean }> | { status?: string; message?: string } | null;
    if (!Array.isArray(body)) {
      const msg = body && typeof body === "object" && "message" in body ? String(body.message) : "unexpected response";
      return { state: "unknown", detail: `Mandrill: ${msg}` };
    }
    const hit = body.find((r) => !r.expired && (r.email ?? "").toLowerCase() === addr.toLowerCase());
    if (hit) return { state: "bounced", reason: hit.reason ?? "denylisted", detail: hit.detail ?? undefined };
    return { state: "ok" };
  } catch (e) {
    const msg = e instanceof Error && e.name === "AbortError" ? "timed out" : e instanceof Error ? e.message : String(e);
    return { state: "unknown", detail: `Mandrill unreachable: ${msg}` };
  }
}
