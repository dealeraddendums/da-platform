// Canonical account_type → tier classification (2026-08-10).
//
// Born from the "448 Trial Dealers" incident: the dashboard counted trials as
// "active AND NOT in a hardcoded paid list", which silently swept in 323 Free
// accounts and misclassified paying dealers on priced variants ("Automatic
// Web $120", "Automatic DMS $140") or with da-billing plan CODES in
// account_type ("sub-auto-web" — written by the 2026-07 billing reconcile
// pass). Three surfaces each had their own drifting copy of the paid list
// (super_admin dashboard, group dashboard, MapboxMap markers).
//
// Client-safe: no server-only imports — MapboxMap (a client component)
// imports this too.

export type AccountTier = "paid" | "trial" | "free";

// Base tier names, compared after stripping the legacy " $price" suffix and
// lowercasing. Covers label forms ("Automatic Web"), full product names
// ("Monthly Subscription Automatic Web"), and da-billing plan codes
// ("sub-auto-web") so historical data quirks classify correctly.
const PAID_BASES = new Set([
  "automatic web",
  "automatic dms",
  "manual",
  "standard",
  "monthly subscription automatic web",
  "monthly subscription automatic dms",
  "monthly subscription manual",
  "sub-auto-web",
  "sub-auto-dms",
  "sub-manual",
]);

/** Classify an account_type into paid / trial / free. NULL/empty/unknown → free. */
export function accountTier(accountType: string | null | undefined): AccountTier {
  const raw = (accountType ?? "").trim();
  if (!raw) return "free";
  const base = raw.split(" $")[0].trim().toLowerCase();
  if (PAID_BASES.has(base)) return "paid";
  if (base === "trial" || base === "trial expired") return "trial";
  return "free";
}

export function isPaidAccountType(accountType: string | null | undefined): boolean {
  return accountTier(accountType) === "paid";
}

export function isTrialAccountType(accountType: string | null | undefined): boolean {
  return accountTier(accountType) === "trial";
}
