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

const STOPWORDS = new Set(("the and for that this with what how can you your are was does have has from into only "
  + "about there their them then than when where which who why will would could should our out get got any all "
  + "not but use using need want just like make made more some also").split(" "));

/**
 * Retrieve the most relevant PUBLISHED dealer help articles for a question.
 *
 * The dealer article set is small (8 as of 2026-10-07), so every article is
 * scored in memory: a question word in the TITLE counts 3, in the body 1,
 * filler words ignored. The old ILIKE-OR picked any 5 articles containing any
 * 3-letter word ("how", "add") in arbitrary order — the "Product Rules"
 * article never reached the model for "a product only for used vehicles".
 * Falls back to the core guides (sort_order) when nothing scores.
 */
export async function getRelevantArticles(query: string, limit = 4): Promise<RetrievedArticle[]> {
  return (await getRelevantArticlesScored(query, limit)).articles;
}

export interface ScoredRetrieval {
  articles: RetrievedArticle[];
  /** False when no article scored at all — the answer falls back to the core
   *  guides and is NOT grounded in anything about the question. */
  matched: boolean;
  top: { title: string; score: number } | null;
}

/** Same selection as getRelevantArticles, plus how good the best match was —
 *  the knowledge-gap log needs to know when Steven had nothing to go on. */
export async function getRelevantArticlesScored(query: string, limit = 4): Promise<ScoredRetrieval> {
  const admin = createAdminSupabaseClient();
  // help_articles isn't in the generated Database type yet (migration 091).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (admin as any).from("help_articles")
    .select("title, category, body, sort_order").eq("published", true).in("audience", ["dealer", "all"])
    .order("sort_order", { ascending: true }).limit(500);
  const all = ((data ?? []) as (RetrievedArticle & { sort_order: number | null })[])
    .map((a) => ({ ...a, text: htmlToText(a.body) }));

  const words = Array.from(new Set(((query ?? "").toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
    .filter((w) => !STOPWORDS.has(w))))
    // crude stem so "vehicles"/"products" match "vehicle"/"product"
    .map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w));

  const scored = all.map((a) => {
    const title = a.title.toLowerCase();
    const body = a.text.toLowerCase();
    const score = words.reduce((n, w) => n + (title.includes(w) ? 3 : 0) + (body.includes(w) ? 1 : 0), 0);
    return { a, score };
  }).filter((x) => x.score > 0).sort((x, y) => y.score - x.score);

  const picked = (scored.length ? scored.map((x) => x.a) : all).slice(0, limit);
  return {
    articles: picked.map((a) => ({ title: a.title, category: a.category, body: a.text })),
    matched: scored.length > 0,
    top: scored.length ? { title: scored[0].a.title, score: scored[0].score } : null,
  };
}
