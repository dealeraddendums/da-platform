// Force-migrate billing pre-flight (2026-10-11).
//
// Decides, BEFORE anything is written, how a force-migration should treat the
// dealer's billing:
//   free  — carry 4.0 Free (or a cancelled 4.0 subscription) over as Free on
//           5.0: no paid plan, no da-billing activation, no "billing error".
//   paid  — the normal path: paid plan + activate the payer's da-billing
//           template (which must exist).
//   block — refuse the force with a clear reason; nothing is changed.
//
// Why: the force used to assume every dealer is paying. Lax Automotive
// (2026-10-11) had gone Free in 4.0 and its FreshBooks profile was deleted, so
// there was no da-billing template to activate — the force landed it on a paid
// 5.0 plan with a raw "setTemplateStatus 404". 5.0's own account_type is not
// trustworthy for this (Lax's still said "Automatic Web"), so the facts come
// from 4.0 itself via the ETL box's read-only /legacy-billing-status.
//
// decideForceBilling() is pure (unit-tested in scripts/force-migration-verify-unit.ts);
// fetchLegacyBillingStatus() is the only I/O.

import { normalizeSubscriptionType } from "@/lib/hubspot";

export interface LegacyBillingStatus {
  ok: boolean;
  found?: boolean;
  ambiguous?: boolean;
  legacy_id?: number;
  account_type?: string | null;
  active?: string | null;
  /** status: none (no RECURE_ID) | ok | disabled | deleted | not_found | error | unknown */
  recurring?: { status: string; profile_id: string | null; next_issue_date?: string | null; amount?: string | null; error?: string };
  error?: string;
}

export interface ForceBillingInput {
  /** null = the ETL box couldn't be reached / answered with an error */
  legacy: LegacyBillingStatus | null;
  /** "group" when the group's da-billing customer pays */
  billedTo: "dealer" | "group";
  /** the payer's da-billing customer id (dealer's, or the group's when group-billed) */
  payerCustomerId: string | null;
  /** the payer's recurring template: null = none; undefined = couldn't read it (ignored when there's no customer) */
  template: { active: boolean | null } | null | undefined;
}

export type ForceBillingDecision =
  | { mode: "free"; reason: string; freshbooksNothingToStop: boolean }
  | { mode: "paid"; reason: string }
  | { mode: "block"; reason: string };

/** FreshBooks states meaning "nothing is billing them in FreshBooks". */
const FB_GONE = new Set(["none", "deleted", "not_found"]);

export function decideForceBilling(i: ForceBillingInput): ForceBillingDecision {
  const L = i.legacy;
  if (!L || !L.ok) return { mode: "block", reason: `couldn't read the dealer's 4.0 billing status (${L?.error ?? "ETL box unreachable"}) — nothing was changed, try again` };
  if (!L.found) return { mode: "block", reason: "dealer not found in 4.0 (dealer_dim) — nothing was changed" };
  if (L.ambiguous) return { mode: "block", reason: "more than one 4.0 dealer has this DEALER_ID — resolve the duplicate before forcing" };

  const tier = normalizeSubscriptionType(L.account_type);
  const fb = L.recurring?.status ?? "unknown";
  const fbGone = FB_GONE.has(fb);
  const fbLabel = fb === "none" ? "no FreshBooks recurring profile" : `FreshBooks recurring profile ${fb}`;

  if (tier === "Trial") return { mode: "block", reason: "the dealer is on a Trial in 4.0 — force-migrate is for paying or Free dealers; handle this one manually" };

  if (tier === "Free") {
    // Group-billed: the group's template carries OTHER stores too, so its being
    // live says nothing about this dealer. Self-billed: a live template of its
    // own means da-billing is already charging a dealer 4.0 calls Free.
    if (i.billedTo === "dealer" && i.template?.active === true) {
      return { mode: "block", reason: "4.0 says Free but the dealer's own da-billing template is LIVE — resolve which is right before forcing" };
    }
    if (!fbGone && fb !== "disabled") {
      // Free in 4.0 but a FreshBooks profile still exists and isn't paused — the
      // operator stop alert still applies, but the plan is Free.
      return { mode: "free", reason: `4.0 account type is Free (${fbLabel} — still needs the operator stop)`, freshbooksNothingToStop: false };
    }
    return { mode: "free", reason: `4.0 account type is Free (${fbLabel})`, freshbooksNothingToStop: true };
  }

  // A paying tier in 4.0 (or unrecognised) — billing has to be in place.
  if (!i.payerCustomerId && i.billedTo === "group") {
    return { mode: "block", reason: "billing not staged — the group has no da-billing customer; stage billing before forcing" };
  }
  if (i.payerCustomerId && i.template === undefined) return { mode: "block", reason: "couldn't read the payer's da-billing template — nothing was changed, try again" };
  if (i.payerCustomerId && i.template) return { mode: "paid", reason: `4.0 account type ${L.account_type ?? "?"}; da-billing template ${i.template.active ? "already live" : "staged"}` };

  if (i.billedTo === "group") {
    return { mode: "block", reason: "billing not staged — the group's da-billing customer has no recurring template; stage billing before forcing" };
  }
  // Self-billed, paid label, no template: cancelled (nothing bills them) or simply not staged.
  if (fbGone) {
    return { mode: "free", reason: `cancelled in 4.0 — account type still reads ${L.account_type ?? "?"}, but there is ${fbLabel} and no da-billing template, so nothing bills them`, freshbooksNothingToStop: true };
  }
  if (fb === "ok") return { mode: "block", reason: `billing not staged — they still pay through FreshBooks but have no da-billing ${i.payerCustomerId ? "template" : "customer"}; stage billing before forcing` };
  if (fb === "disabled") return { mode: "block", reason: "their FreshBooks profile is paused and there is no da-billing template — confirm whether they still pay before forcing" };
  return { mode: "block", reason: `couldn't confirm their FreshBooks status (${L.recurring?.error ?? fb}) — nothing was changed, try again` };
}

/** Read-only 4.0 facts from the ETL box. Never throws; null on any failure. */
export async function fetchLegacyBillingStatus(legacyDealerId: string): Promise<LegacyBillingStatus | null> {
  const etlUrl = process.env.ETL_SYNC_URL;
  const etlKey = process.env.ETL_SYNC_API_KEY;
  if (!etlUrl || !etlKey) return { ok: false, error: "ETL_SYNC_URL / ETL_SYNC_API_KEY not configured" };
  const base = etlUrl.replace(/\/sync\/?$/, "");
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${base}/legacy-billing-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": etlKey },
      body: JSON.stringify({ dealer_id: legacyDealerId }),
      signal: controller.signal,
    });
    const j = (await res.json().catch(() => null)) as LegacyBillingStatus | null;
    if (!res.ok || !j) return { ok: false, error: `ETL box HTTP ${res.status}` };
    return j;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(t);
  }
}
