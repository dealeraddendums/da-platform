// Shared write-path rules for Help Center articles (used by POST and PUT so the
// two can't drift).
import { isHelpMediaUrl } from "@/lib/help-media";

/**
 * A ProductFruits tour id. PF's own ids are numeric, but we store text so a
 * future/aliased id still round-trips. Restricted charset because the value is
 * handed to the PF SDK in the browser.
 */
export function normalizeTourId(raw: unknown): string | null | undefined {
  if (typeof raw !== "string") return undefined; // field absent — leave alone
  const v = raw.trim();
  if (!v) return null; // explicitly cleared
  return /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : undefined;
}
export function isValidTourId(raw: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(raw.trim());
}

export type UrlCheck = { ok: true; value: string | null } | { ok: false; error: string };

/**
 * The attached PDF. The dealer article page frames this URL, so it must be one
 * of our own uploads — never an operator-pasted foreign host.
 */
export function checkPdfUrl(raw: unknown): UrlCheck {
  if (typeof raw !== "string") return { ok: true, value: null };
  const v = raw.trim();
  if (!v) return { ok: true, value: null };
  if (!isHelpMediaUrl(v)) {
    return { ok: false, error: "PDF must be uploaded here — an external link can't be attached." };
  }
  return { ok: true, value: v };
}

export type HelpCategory = { id: string; name: string };

/**
 * Resolve a category id to its row. `category_id` is the authoritative grouping
 * key; `help_articles.category` (text) is kept as a synced copy because the Help
 * assistant's retrieval reads it (lib/help-context.ts).
 */
export async function resolveCategory(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  categoryId: unknown,
): Promise<HelpCategory | null> {
  if (typeof categoryId !== "string" || !categoryId.trim()) return null;
  const { data } = await admin
    .from("help_categories").select("id, name").eq("id", categoryId).maybeSingle();
  return (data as HelpCategory | null) ?? null;
}

/**
 * Every audience an article may carry (migration 091, extended by 160).
 * 'internal' is STAFF-ONLY: no dealer-facing surface may ever return it.
 */
export const ARTICLE_AUDIENCES = ["dealer", "group", "all", "internal"] as const;
export type ArticleAudience = (typeof ARTICLE_AUDIENCES)[number];

/**
 * The audiences a given role may READ — the single allowlist behind browse,
 * search and the by-id fetch, so those three cannot drift apart.
 *
 * Deliberately an allowlist, not a denylist of 'internal': a future audience
 * value is then invisible to dealers until someone opts it in, which is the
 * safe direction to fail.
 *
 * super_admin is not handled here — staff read everything through the CMS
 * (`?all=1`), which skips this filter entirely.
 */
export function readableAudiences(role: string): ArticleAudience[] {
  return role === "group_admin" ? ["dealer", "all", "group"] : ["dealer", "all"];
}
