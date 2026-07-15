// Single source of truth for "can this dealer print right now" — used by
// the four server-side print routes (pdf/generate, pdf/bulk,
// print/[vehicleId], print/bulk), the dashboard inventory UI button
// gates, AND the HubSpot lifecyclestage derivation in
// lib/sync-hubspot.ts. Spec: docs/print-eligibility-free-expired.md.
//
// Rules:
//   Paid (Manual / Auto-Web / Auto-DMS / PAYGo, ± "$price" suffix) → print
//   Trial within allowance (≤30 days since created_at AND ≤30 lifetime_prints) → print
//   Trial over allowance OR Free OR Downgraded → no print, can still log in
//
// Free is never a starting state per the spec — a dealer only becomes
// Free by downgrading from a paid plan. So the "free_downgraded" bucket
// also covers any non-trial-non-paid account_type value.

import { NextResponse } from "next/server";
import { normalizeSubscriptionType, isPayingAccount } from "@/lib/hubspot";
import { createAdminSupabaseClient } from "@/lib/db";
import { billingConfigured, getBillingStatus } from "@/lib/billing";
import { printedVehicleCount } from "@/lib/print-counts";

export const TRIAL_DAYS_CAP = 30;
export const TRIAL_PRINTS_CAP = 30;

export interface DealerEligibility {
  account_type: string | null;
  created_at: string | null;        // ISO timestamp; null treated as "now" (just-created)
  lifetime_prints: number | null;
  /** Operator-set expiry override (migration 126). NULL = created_at + 30 days. */
  trial_ends_at?: string | null;
  /** Operator-set print-cap override (migration 126). NULL = 30. */
  trial_prints_cap?: number | null;
}

/**
 * Paid subscriber. Wraps lib/hubspot.ts isPayingAccount so we share one
 * normalization (strips "$price" suffix, accepts short + long + new-platform
 * forms). True for Manual / Auto-Web / Auto-DMS / PAYGo.
 */
export function isPaidAccountType(at: string | null | undefined): boolean {
  return isPayingAccount(at);
}

/**
 * Trial-track account. Explicit "Trial" string OR null (the unset default —
 * fresh signups have account_type=null until something sets it). "Standard"
 * and other unmapped legacy strings are NOT trial — they fall through to
 * the Downgraded bucket because the audit (2026-06-01) showed those rows
 * carry no da-billing subscription and are well past 30 days.
 */
export function isTrialAccountType(at: string | null | undefined): boolean {
  if (at == null) return true;
  return normalizeSubscriptionType(at) === "Trial";
}

/**
 * Downgraded — explicit "Free" string. (downgraded_at being set is checked
 * separately in the lifecycle derivation; this is account_type-only.)
 */
export function isFreeAccountType(at: string | null | undefined): boolean {
  return normalizeSubscriptionType(at) === "Free";
}

/**
 * Over-allowance: trial cap exceeded on EITHER axis (30 days OR 30 prints).
 * Shared by canPrint and the HubSpot Trial → Trial Expired derivation so
 * the two surfaces never disagree about who's expired.
 *
 * Operator overrides (migration 126, set by the SuperAdmin extend-trial
 * action): trial_ends_at replaces the created_at + 30d time axis, and
 * trial_prints_cap replaces the 30-print cap. NULL = default behavior.
 */
export function isOverAllowance(d: {
  created_at?: string | null;
  lifetime_prints?: number | null;
  trial_ends_at?: string | null;
  trial_prints_cap?: number | null;
}): boolean {
  const createdAt = d.created_at ? new Date(d.created_at).getTime() : Date.now();
  const endsAt = d.trial_ends_at
    ? new Date(d.trial_ends_at).getTime()
    : createdAt + TRIAL_DAYS_CAP * 24 * 60 * 60 * 1000;
  const prints = d.lifetime_prints ?? 0;
  const printsCap = d.trial_prints_cap ?? TRIAL_PRINTS_CAP;
  return Date.now() > endsAt || prints > printsCap;
}

/**
 * Operator-granted trial window that is still running. Grants trial-track
 * treatment even when account_type says Free/legacy — the daily ETL can
 * revert account_type from Aurora for unmigrated dealers, so the extension
 * must not depend on it.
 */
export function hasActiveTrialOverride(d: { trial_ends_at?: string | null }): boolean {
  return !!d.trial_ends_at && new Date(d.trial_ends_at).getTime() > Date.now();
}

export type CanPrintReason = "trial_expired" | "free_downgraded" | "past_due";

/** Past-due copy varies by the RESPONSIBLE PAYER (subscription_billed_to) — the
 *  same discriminator the lock uses, not "is in a group". A self-billed dealer
 *  that happens to sit in a group still gets the self-billed message. */
export const PAST_DUE_MESSAGE_GROUP =
  "Printing is paused. To restore it, please contact your Group Administrator.";
export const PAST_DUE_MESSAGE_SELF =
  "Printing is temporarily disabled due to a past-due invoice.";

export interface CanPrintResult {
  ok: boolean;
  reason?: CanPrintReason;
  /** User-facing copy. The route uses this verbatim in 403 responses; the
   *  UI shows it in the disabled-button tooltip. */
  message?: string;
  /** For past_due blocks: which payer is responsible, so the UI/analytics can
   *  branch the same way the message does. Mirrors subscription_billed_to. */
  billedBy?: "group" | "self";
}

export function canPrint(d: DealerEligibility): CanPrintResult {
  if (isPaidAccountType(d.account_type)) return { ok: true };
  if (isTrialAccountType(d.account_type) || hasActiveTrialOverride(d)) {
    if (!isOverAllowance(d)) return { ok: true };
    return {
      ok: false,
      reason: "trial_expired",
      message: "Your trial limit is reached — upgrade to keep printing.",
    };
  }
  // Free / Downgraded / unmapped legacy strings.
  return {
    ok: false,
    reason: "free_downgraded",
    message: "Your account is downgraded — upgrade to keep printing.",
  };
}

// ── Past-due billing gate ────────────────────────────────────────────────────
//
// A dealer can't print when the responsible billing customer is past due in
// da-billing. Short-TTL cache so the gate isn't a per-print round-trip; FAIL
// OPEN on any da-billing error (never block a paying dealer on a service hiccup).

const BILLING_TTL_MS = 20 * 60 * 1000; // 20 min
const billingPastDueCache = new Map<string, { pastDue: boolean; at: number }>();

/** Cached past_due read for one da-billing customer. Fail-open (false) on error
 *  — and the failure is NOT cached, so it retries on the next call. */
async function customerPastDue(customerId: string): Promise<boolean> {
  const hit = billingPastDueCache.get(customerId);
  if (hit && Date.now() - hit.at < BILLING_TTL_MS) return hit.pastDue;
  try {
    const status = await getBillingStatus(customerId);
    const pastDue = status?.past_due === true;
    billingPastDueCache.set(customerId, { pastDue, at: Date.now() });
    return pastDue;
  } catch {
    return false; // FAIL OPEN
  }
}

/**
 * Is the dealer blocked by a past-due balance? Resolves the *responsible* payer:
 * a group-billed dealer (subscription_billed_to='group') is gated on its GROUP's
 * da-billing customer; a self/dealer-billed dealer on its own. Fail-open when
 * billing isn't configured or no da-billing customer resolves (can't confirm
 * past_due → allow).
 */
async function dealerPastDue(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  d: { subscription_billed_to: string | null; billing_customer_id: string | null; group_id: string | null },
): Promise<boolean> {
  if (!billingConfigured()) return false;
  let customerId: string | null;
  if (d.subscription_billed_to === "group" && d.group_id) {
    const { data: g } = await admin
      .from("groups")
      .select("billing_customer_id")
      .eq("id", d.group_id)
      .maybeSingle<{ billing_customer_id: string | null }>();
    customerId = g?.billing_customer_id ?? null;
  } else {
    customerId = d.billing_customer_id ?? null;
  }
  if (!customerId) return false; // no resolvable payer → can't confirm → allow
  return customerPastDue(customerId);
}

/**
 * Resolve canPrint for a dealer from its text id — looks up account_type,
 * created_at, and lifetime print count from print_history, applies the
 * Trial/Free gate, then (if that passes) the past-due billing gate. Used by
 * both the server-route gate (enforceCanPrint) and server-rendered pages that
 * pass the result into a client component for the UI gate.
 */
export async function canPrintForDealer(dealerTextId: string): Promise<CanPrintResult> {
  const admin = createAdminSupabaseClient();
  const { data: dealer } = await admin
    .from("dealers")
    .select("account_type, created_at, subscription_billed_to, billing_customer_id, group_id, trial_ends_at, trial_prints_cap")
    .eq("dealer_id", dealerTextId)
    .maybeSingle<{
      account_type: string | null;
      created_at: string | null;
      subscription_billed_to: string | null;
      billing_customer_id: string | null;
      group_id: string | null;
      trial_ends_at: string | null;
      trial_prints_cap: number | null;
    }>();

  // Unknown dealer — be permissive; route-level 404s handle the actual error
  // path. Returning ok=true here means the UI shows the buttons enabled,
  // which is the right default for the rare race.
  if (!dealer) return { ok: true };

  // Lifetime prints = DISTINCT vehicles printed, not print_history rows (a row
  // is logged per vehicle per PDF generation, so reprints would inflate the
  // count and wrongly trip the cap — docs/multiprint-qa-2026-06-11.md Issue B).
  // Only trial accounts need the number: paid passes outright and Free/
  // Downgraded blocks outright, so skip the query for both.
  let lifetimePrints = 0;
  if (isTrialAccountType(dealer.account_type) || hasActiveTrialOverride(dealer)) {
    lifetimePrints = await printedVehicleCount(admin, { dealerId: dealerTextId });
  }

  // Trial/Free gate (pure) — any block here wins; no need to hit da-billing.
  const base = canPrint({
    account_type: dealer.account_type,
    created_at: dealer.created_at,
    lifetime_prints: lifetimePrints,
    trial_ends_at: dealer.trial_ends_at,
    trial_prints_cap: dealer.trial_prints_cap,
  });
  if (!base.ok) return base;

  // Past-due gate stacks on top: a paying, in-allowance dealer is still blocked
  // when its (or its group's) balance is past due. Message varies by payer.
  if (await dealerPastDue(admin, dealer)) {
    const billedBy = dealer.subscription_billed_to === "group" ? "group" : "self";
    return {
      ok: false,
      reason: "past_due",
      billedBy,
      message: billedBy === "group" ? PAST_DUE_MESSAGE_GROUP : PAST_DUE_MESSAGE_SELF,
    };
  }

  return { ok: true };
}

/**
 * Bust the cached billing status for a customer (or all when no id). Called by
 * the da-billing → da-platform invalidate webhook the moment a customer's
 * Overdue Days changes or an invoice is paid/voided, so the print lock reflects
 * the change immediately instead of waiting out the 20-min TTL backstop.
 */
export function invalidateBillingStatusCache(customerId?: string | null): void {
  if (customerId) billingPastDueCache.delete(customerId);
  else billingPastDueCache.clear();
}

/**
 * Server-route helper. Returns null when the print may proceed, or a 403
 * NextResponse when it must be blocked.
 *
 * super_admin always bypasses the gate — operators may print on behalf
 * of any dealer for support / testing / cleanup. The dealer-facing
 * roles (dealer_admin / dealer_user / group_admin) are the ones the
 * gate enforces against.
 */
export async function enforceCanPrint(
  dealerTextId: string,
  claims: { role: string },
): Promise<NextResponse | null> {
  if (claims.role === "super_admin") return null;
  const result = await canPrintForDealer(dealerTextId);
  if (result.ok) return null;
  return NextResponse.json(
    { error: result.message, reason: result.reason },
    { status: 403 },
  );
}
