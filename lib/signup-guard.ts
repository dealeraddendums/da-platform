// Deterministic gates for the PUBLIC self-serve trial signup (Layers 1 + 2).
//
// Cheap, no-network-except-DNS checks that run BEFORE the AI evaluation, so an
// obvious abuser never costs us a model call. Every outcome is recorded in
// self_serve_signups (migration 154) by the caller, including the blocks — the
// point of the exercise is that overnight abuse volume becomes visible.
//
// These apply ONLY to the public path. super_admin / group-admin dealer
// creation (POST /api/dealers) and existing-user logins do not import this.

import { promises as dns } from "node:dns";
import type { SupabaseClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any, any, any>;

// ── Layer 2: business-hours window ──────────────────────────────────────────
// Allan's rule: no new self-serve trials 9 PM – 5 AM Pacific. Enforced with
// the IANA zone, never a fixed offset, so it follows DST automatically (PDT in
// summer is UTC-7, PST in winter UTC-8 — a hardcoded offset would silently
// shift the window by an hour twice a year).
export const SIGNUP_OPEN_HOUR = 5;   // inclusive
export const SIGNUP_CLOSE_HOUR = 21; // exclusive
export const SIGNUP_TZ = "America/Los_Angeles";

export function pacificHour(at: Date = new Date()): number {
  // en-US + hourCycle h23 gives a plain 0–23 hour in the target zone.
  const hh = new Intl.DateTimeFormat("en-US", {
    timeZone: SIGNUP_TZ, hour: "2-digit", hourCycle: "h23",
  }).format(at);
  return Number.parseInt(hh, 10);
}

export function isWithinSignupHours(at: Date = new Date()): boolean {
  const h = pacificHour(at);
  return h >= SIGNUP_OPEN_HOUR && h < SIGNUP_CLOSE_HOUR;
}

export const AFTER_HOURS_MESSAGE =
  "Sign-ups are open 5 AM–9 PM Pacific — please try again during business hours.";

// ── Layer 1: disposable / undeliverable email domains ───────────────────────
// A curated list of the throwaway providers we actually see, plus an MX lookup.
// The MX check is the general defence: a domain that cannot receive mail can
// never confirm the Layer-0 email, so provisioning for it is pointless.
//
// Honest limitation: a parked domain with a wildcard MX still passes both
// checks. wshu.net and virgilian.com (the 2026-09-03 signups) are exactly that
// shape — the AI layer, not this one, is what catches them. This layer removes
// the cheap noise so the model only sees plausible-looking traffic.
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "sharklasers.com",
  "10minutemail.com", "10minutemail.net", "tempmail.com", "temp-mail.org",
  "throwawaymail.com", "yopmail.com", "yopmail.net", "getnada.com", "nada.email",
  "dispostable.com", "trashmail.com", "trashmail.de", "mytrashmail.com",
  "fakeinbox.com", "mailnesia.com", "maildrop.cc", "harakirimail.com",
  "grr.la", "spam4.me", "tempr.email", "discard.email", "mailcatch.com",
  "inboxbear.com", "emailondeck.com", "mohmal.com", "moakt.com",
  "tempmailo.com", "burnermail.io", "anonaddy.me", "mailz.info",
  "spambog.com", "spambox.us", "byom.de", "einrot.com", "cuvox.de",
  "dayrep.com", "armyspy.com", "teleworm.us", "rhyta.com", "jourrapide.com",
  "superrito.com", "gustr.com", "fleckens.hu",
]);

export function emailDomain(email: string): string {
  return String(email ?? "").trim().toLowerCase().split("@")[1] ?? "";
}

export function isDisposableDomain(email: string): boolean {
  return DISPOSABLE_DOMAINS.has(emailDomain(email));
}

/** Does the address's domain publish MX records? Undeliverable domains can
 *  never confirm the Layer-0 email, so they are rejected. A DNS failure is
 *  treated as "has MX" — a resolver hiccup must not reject a real dealer. */
export async function domainHasMx(email: string, timeoutMs = 3000): Promise<{ ok: boolean; checked: boolean }> {
  const domain = emailDomain(email);
  if (!domain) return { ok: false, checked: true };
  try {
    const lookup = dns.resolveMx(domain);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("mx-timeout")), timeoutMs));
    const records = await Promise.race([lookup, timeout]);
    return { ok: Array.isArray(records) && records.length > 0, checked: true };
  } catch (err) {
    const code = (err as { code?: string }).code;
    // NXDOMAIN / ENODATA are real answers: the domain cannot receive mail.
    if (code === "ENOTFOUND" || code === "ENODATA" || code === "NXDOMAIN") {
      return { ok: false, checked: true };
    }
    // Anything else (timeout, SERVFAIL, resolver down) — fail OPEN.
    return { ok: true, checked: false };
  }
}

// ── Layer 1: field sanity ───────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const US_ZIP_RE = /^\d{5}(-\d{4})?$/;

export function fieldSanity(input: {
  email?: string; name?: string; dealership?: string; zip?: string | null;
}): { ok: true } | { ok: false; reason: string } {
  const email = input.email?.trim() ?? "";
  const name = input.name?.trim() ?? "";
  const dealership = input.dealership?.trim() ?? "";
  if (!EMAIL_RE.test(email)) return { ok: false, reason: "invalid email" };
  if (name.length < 2) return { ok: false, reason: "contact name too short" };
  if (dealership.length < 2) return { ok: false, reason: "dealership name too short" };
  // Zip is optional (the form allows blank), but a supplied one must be a real
  // US zip. "232923" (a real past signup) is the shape this rejects.
  if (input.zip && input.zip.trim() && !US_ZIP_RE.test(input.zip.trim())) {
    return { ok: false, reason: `zip "${input.zip.trim()}" is not a US ZIP code` };
  }
  return { ok: true };
}

// ── Layer 1: per-IP rate limit, in SHARED state ─────────────────────────────
// The old limiter was a module-level Map: per-PM2-worker (2 cluster workers →
// double the intended ceiling) and reset by every deploy. This counts rows in
// self_serve_signups instead, so it is global and survives restarts.
//
// Blocked attempts count toward the limit deliberately — otherwise hammering
// the endpoint after a block costs nothing.
export const IP_LIMIT = 3;
export const IP_WINDOW_MINUTES = 60;

export async function ipRateLimitExceeded(
  admin: Admin, sourceIp: string | null,
): Promise<{ exceeded: boolean; recent: number }> {
  if (!sourceIp || sourceIp === "unknown") return { exceeded: false, recent: 0 };
  const since = new Date(Date.now() - IP_WINDOW_MINUTES * 60_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count, error } = await (admin as any)
    .from("self_serve_signups")
    .select("id", { count: "exact", head: true })
    .eq("source_ip", sourceIp)
    .gte("created_at", since);
  // Fail OPEN on a DB error: the AI layer and Turnstile still stand, and a
  // transient Supabase blip must not break legitimate signups.
  if (error) return { exceeded: false, recent: 0 };
  const recent = count ?? 0;
  return { exceeded: recent >= IP_LIMIT, recent };
}
