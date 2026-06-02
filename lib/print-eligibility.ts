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

export const TRIAL_DAYS_CAP = 30;
export const TRIAL_PRINTS_CAP = 30;

export interface DealerEligibility {
  account_type: string | null;
  created_at: string | null;        // ISO timestamp; null treated as "now" (just-created)
  lifetime_prints: number | null;
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
 */
export function isOverAllowance(d: { created_at?: string | null; lifetime_prints?: number | null }): boolean {
  const createdAt = d.created_at ? new Date(d.created_at).getTime() : Date.now();
  const ageDays = (Date.now() - createdAt) / (1000 * 60 * 60 * 24);
  const prints = d.lifetime_prints ?? 0;
  return ageDays > TRIAL_DAYS_CAP || prints > TRIAL_PRINTS_CAP;
}

export type CanPrintReason = "trial_expired" | "free_downgraded";

export interface CanPrintResult {
  ok: boolean;
  reason?: CanPrintReason;
  /** User-facing copy. The route uses this verbatim in 403 responses; the
   *  UI shows it in the disabled-button tooltip. */
  message?: string;
}

export function canPrint(d: DealerEligibility): CanPrintResult {
  if (isPaidAccountType(d.account_type)) return { ok: true };
  if (isTrialAccountType(d.account_type)) {
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

/**
 * Resolve canPrint for a dealer from its text id — looks up account_type,
 * created_at, and lifetime print count from print_history. Used by both
 * the server-route gate (enforceCanPrint) and server-rendered pages that
 * need to pass the result into a client component for the UI gate.
 */
export async function canPrintForDealer(dealerTextId: string): Promise<CanPrintResult> {
  const admin = createAdminSupabaseClient();
  const { data: dealer } = await admin
    .from("dealers")
    .select("account_type, created_at")
    .eq("dealer_id", dealerTextId)
    .maybeSingle<{ account_type: string | null; created_at: string | null }>();

  // Unknown dealer — be permissive; route-level 404s handle the actual error
  // path. Returning ok=true here means the UI shows the buttons enabled,
  // which is the right default for the rare race.
  if (!dealer) return { ok: true };

  const { count: lifetimePrints } = await admin
    .from("print_history")
    .select("id", { count: "exact", head: true })
    .eq("dealer_id", dealerTextId);

  return canPrint({
    account_type: dealer.account_type,
    created_at: dealer.created_at,
    lifetime_prints: lifetimePrints ?? 0,
  });
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
