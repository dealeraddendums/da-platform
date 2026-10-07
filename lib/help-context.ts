// Safe, OWN-DATA-ONLY context for the Help assistant + help-article retrieval.
//
// SECURITY: the dealer is resolved from the caller's claims via
// resolveEffectiveDealer (getJwtClaims already pins a group_admin to their
// group-verified ACTIVE dealer, a dealer role to their own dealer, a super_admin
// to their ghost dealer). We NEVER accept a dealer id from the request, so the
// assistant can only ever see the signed-in user's own/active dealer. No
// card/payment data or PII beyond account basics is included.

import type { JwtClaims } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveEffectiveDealer } from "@/lib/dealer-authz";
import {
  TRIAL_DAYS_CAP, TRIAL_PRINTS_CAP, canPrint, canPrintForDealer,
  isPaidAccountType, isTrialAccountType,
} from "@/lib/print-eligibility";
import { htmlToText, type RetrievedArticle } from "@/lib/help-knowledge";

/**
 * Build the dealer-safe context block for the prompt (own/active dealer only).
 *
 * The effective dealer is resolved ONLY from `claims` (never a request-supplied
 * id) — that own-data-only guarantee is the security property. `admin` is an
 * injection seam for tests; production uses the default service-role client.
 */
export async function buildDealerContext(
  claims: JwtClaims,
  admin: ReturnType<typeof createAdminSupabaseClient> = createAdminSupabaseClient(),
): Promise<string> {
  const role = claims.role;
  const lines: string[] = [`Role: ${role}${claims.group_id ? " (in a dealer group)" : ""}`];

  const dealerTextId = resolveEffectiveDealer(claims);
  if (!dealerTextId) {
    lines.push(
      role === "group_admin"
        ? "Not currently switched into a specific dealership, so no dealer-specific account data is available. Answer general how-to questions; for account specifics, the user should switch into a dealer."
        : "No specific dealership account is in context. Answer general how-to questions."
    );
    return lines.join("\n");
  }

  const { data: dealer } = await admin
    .from("dealers")
    .select("name, account_type, created_at, downgraded_at, subscription_billed_to, group_controls_templates, trial_ends_at, trial_prints_cap, migration_status, is_native, converted_at")
    .eq("dealer_id", dealerTextId)
    .maybeSingle<{
      name: string | null; account_type: string | null; created_at: string | null;
      downgraded_at: string | null; subscription_billed_to: string | null; group_controls_templates: boolean | null;
      trial_ends_at: string | null; trial_prints_cap: number | null;
      migration_status: string | null; is_native: boolean | null; converted_at: string | null;
    }>();

  if (!dealer) {
    lines.push("Dealer account context unavailable.");
    return lines.join("\n");
  }

  const { count: lifetimePrints } = await admin
    .from("print_history")
    .select("id", { count: "exact", head: true })
    .eq("dealer_id", dealerTextId);
  const prints = lifetimePrints ?? 0;

  lines.push(`Dealership: ${dealer.name ?? "(unnamed)"}`);

  // Plan + print status — the "why can't I print?" answer.
  const at = dealer.account_type;
  if (isPaidAccountType(at)) {
    lines.push(`Plan: Paid (${at}). Printing is enabled (no trial limits).`);
  } else if (isTrialAccountType(at)) {
    // An extended trial (Extend Trial: trial_ends_at / trial_prints_cap) overrides
    // the 30-day / 30-print defaults — quote the dealer's real limits.
    const createdMs = dealer.created_at ? new Date(dealer.created_at).getTime() : Date.now();
    const endMs = dealer.trial_ends_at ? new Date(dealer.trial_ends_at).getTime() : createdMs + TRIAL_DAYS_CAP * 86_400_000;
    const daysLeft = Math.max(0, Math.ceil((endMs - Date.now()) / 86_400_000));
    const cap = dealer.trial_prints_cap ?? TRIAL_PRINTS_CAP;
    const printsLeft = Math.max(0, cap - prints);
    const res = canPrint({ account_type: at, created_at: dealer.created_at, lifetime_prints: prints, trial_ends_at: dealer.trial_ends_at, trial_prints_cap: dealer.trial_prints_cap });
    lines.push(
      `Plan: Trial. Prints used ${prints} of ${cap} (${printsLeft} left). ` +
      `Trial ends ${new Date(endMs).toISOString().slice(0, 10)} (${daysLeft} days left). ` +
      (res.ok
        ? "Printing is currently enabled."
        : "Printing is currently PAUSED because the trial limit is reached — they upgrade from My Profile → Billing.")
    );
  } else {
    lines.push(`Plan: Free / downgraded${dealer.downgraded_at ? "" : ""}. Printing is PAUSED — they re-subscribe from My Profile → Billing to restore printing.`);
  }

  // The authoritative print gate (trial/Free + the past-due billing lock) — the
  // same check the Print buttons use, so "why can't I print?" matches reality.
  try {
    const gate = await canPrintForDealer(dealerTextId);
    if (!gate.ok && gate.reason === "past_due") {
      lines.push(`Billing: PAST DUE — printing is paused. ${gate.message ?? ""}`.trim());
    }
  } catch { /* fail open, like the gate itself */ }

  if (dealer.is_native) {
    lines.push("Platform: created on DA Platform 5.0.");
  } else if (dealer.migration_status === "migrated") {
    lines.push(`Platform: migrated from DA 4.0 to 5.0${dealer.converted_at ? ` (${dealer.converted_at.slice(0, 10)})` : ""}.`);
  } else {
    lines.push("Platform: this dealership still lives on DA 4.0 and hasn't finished moving to 5.0 — some data (settings, products) may still be syncing from 4.0.");
  }

  if (dealer.subscription_billed_to === "group") {
    lines.push("Billing: this dealership's subscription is billed through its group; billing is managed by the group admin.");
  }
  if (dealer.group_controls_templates) {
    lines.push("Templates: this dealership's templates are managed by its group (Builder may be limited).");
  }

  return lines.join("\n");
}

/**
 * Retrieve the most relevant PUBLISHED dealer help articles for a question.
 * Keyword ILIKE over title/body (article set is small); falls back to the core
 * guides when nothing matches so answers stay grounded.
 */
export async function getRelevantArticles(query: string, limit = 5): Promise<RetrievedArticle[]> {
  const admin = createAdminSupabaseClient();
  // help_articles isn't in the generated Database type yet (migration 091).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = () =>
    (admin as any).from("help_articles").select("title, category, body").eq("published", true).in("audience", ["dealer", "all"]);

  const words = (query ?? "").toLowerCase().match(/[a-z0-9]{3,}/g)?.slice(0, 8) ?? [];
  let articles: RetrievedArticle[] = [];
  if (words.length) {
    const ors = words.map((w) => `title.ilike.%${w}%,body.ilike.%${w}%`).join(",");
    const { data } = await base().or(ors).limit(limit);
    articles = (data as RetrievedArticle[] | null) ?? [];
  }
  if (articles.length === 0) {
    const { data } = await base().order("sort_order", { ascending: true }).limit(limit);
    articles = (data as RetrievedArticle[] | null) ?? [];
  }
  // de-dup by title, keep plain bodies trimmed (the prompt builder trims again)
  const seen = new Set<string>();
  return articles.filter((a) => (seen.has(a.title) ? false : (seen.add(a.title), true)))
    .map((a) => ({ title: a.title, category: a.category, body: htmlToText(a.body) }));
}
