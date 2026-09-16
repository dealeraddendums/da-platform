// Server-only: the "trial signups need attention" count behind the admin
// topbar badge, and the stuck-lead list + resend behind /admin/trial-signups.
//
// Two buckets, because there are two distinct ways a waiting dealer gets missed:
//
//   A. needsReview — self_serve_signups.decision = 'pending_review'. The gate
//      held the signup for a human; nothing exists until someone approves it.
//      Lives in THIS project (migration 154).
//
//   B. stuck — a lead submitted the form and never clicked the Layer 0
//      confirmation link, so it never provisioned. These rows live in the
//      da-marketing-os Supabase project (marketing_leads), which this app has
//      no credentials for, so they come over HTTP from
//      GET {MARKETING_URL}/api/leads/pending-confirmation, authenticated with
//      the MARKETING_WEBHOOK_SECRET both apps already share.
//
// Bucket B is FAIL-SOFT on purpose: if marketing is down, slow, or
// unconfigured, the badge still reports bucket A rather than disappearing. A
// missing half of the count is a much smaller failure than a missing badge,
// which is the exact "nobody noticed" problem this feature exists to fix.

import { createAdminSupabaseClient } from "@/lib/db";

export interface PendingSignupCounts {
  total: number;
  needsReview: number;
  /** null (not 0) when the marketing lookup failed — "unknown", not "none". */
  stuck: number | null;
  /** False when bucket B could not be read, so the UI can stay honest. */
  stuckAvailable: boolean;
}

export interface StuckLead {
  id: string;
  created_at: string;
  name: string | null;
  email: string;
  dealership: string | null;
  zip: string | null;
  confirm_sent_at: string | null;
  hoursWaiting: number;
}

function marketingBase(): string {
  // www, not the apex: the apex is still the legacy Apache site and has no
  // /api routes (the same trap that 404'd confirmation links until c131857).
  return (process.env.MARKETING_URL ?? "https://www.dealeraddendums.com").replace(/\/$/, "");
}

function marketingConfigured(): boolean {
  return !!process.env.MARKETING_WEBHOOK_SECRET;
}

/** One short, bounded call to the marketing app. Never throws. */
async function fetchMarketing<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = 4000,
): Promise<T | null> {
  if (!marketingConfigured()) {
    console.warn("[pending-signups] MARKETING_WEBHOOK_SECRET unset — stuck-lead bucket unavailable");
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${marketingBase()}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        "X-Webhook-Secret": process.env.MARKETING_WEBHOOK_SECRET as string,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[pending-signups] marketing ${path} -> ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[pending-signups] marketing ${path} failed:`,
      err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Server-side count cache. Lives here, not in the route module: a Next.js
 * route.ts may only export the HTTP handlers and its recognised config, so an
 * extra exported helper there is a build hazard.
 *
 * 45s means a topbar polling every 60s across several open admin tabs costs one
 * head-count plus one marketing call per window, not one per tab.
 */
const COUNT_TTL_MS = 45_000;
let countCache: { at: number; value: PendingSignupCounts } | null = null;

export function getCachedPendingCounts(): PendingSignupCounts | null {
  if (countCache && Date.now() - countCache.at < COUNT_TTL_MS) return countCache.value;
  return null;
}

export function setCachedPendingCounts(value: PendingSignupCounts): void {
  countCache = { at: Date.now(), value };
}

/** Drop the cache so the next poll reflects a just-completed approve/resend. */
export function invalidatePendingCounts(): void {
  countCache = null;
}

/**
 * Counts for the badge. Exact PostgREST HEAD count for bucket A — no rows
 * cross the wire, and a head count is immune to the 1000-row read clamp that
 * would silently cap a `select().length`.
 */
export async function getPendingSignupCounts(): Promise<PendingSignupCounts> {
  const admin = createAdminSupabaseClient();

  let needsReview = 0;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { count, error } = await (admin as any)
      .from("self_serve_signups")
      .select("id", { count: "exact", head: true })
      .eq("decision", "pending_review");
    if (error) console.error("[pending-signups] needsReview count failed:", error.message);
    else needsReview = count ?? 0;
  } catch (err) {
    console.error("[pending-signups] needsReview threw:", err instanceof Error ? err.message : err);
  }

  const mk = await fetchMarketing<{ count: number }>("/api/leads/pending-confirmation");
  const stuck = mk ? (mk.count ?? 0) : null;

  return {
    total: needsReview + (stuck ?? 0),
    needsReview,
    stuck,
    stuckAvailable: mk !== null,
  };
}

/** The stuck-lead rows for the /admin/trial-signups list. Empty on failure. */
export async function getStuckLeads(): Promise<{ leads: StuckLead[]; available: boolean; stuckAfterHours: number | null }> {
  const mk = await fetchMarketing<{ count: number; leads: StuckLead[]; stuckAfterHours: number }>(
    "/api/leads/pending-confirmation",
    {},
    6000, // list is heavier than the count
  );
  if (!mk) return { leads: [], available: false, stuckAfterHours: null };
  return { leads: mk.leads ?? [], available: true, stuckAfterHours: mk.stuckAfterHours ?? null };
}

/**
 * Staff-initiated resend of a Layer 0 confirmation email.
 *
 * Proxies to marketing, which reuses its own resendConfirmation(): fresh token,
 * new confirm_sent_at, same 10-minute DB cooldown. It does NOT confirm on the
 * prospect's behalf — the whole point of Layer 0 is that only the mailbox owner
 * can do that.
 */
export async function resendLeadConfirmation(
  email: string,
): Promise<{ ok: boolean; outcome: string; message: string }> {
  const mk = await fetchMarketing<{ ok: boolean; outcome: string; message: string }>(
    "/api/leads/pending-confirmation",
    { method: "POST", body: JSON.stringify({ email }) },
    8000, // sends an email
  );
  if (!mk) {
    return { ok: false, outcome: "unreachable", message: "Could not reach the marketing site to send it." };
  }
  return mk;
}
