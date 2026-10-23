// Self-serve hook: a dealer (or their group admin) switches Manual / Free /
// Trial → Automatic in-app (PATCH /api/billing/me/subscription) → a feed order
// (source self_serve) opens in DA-CRM with whatever the form collected —
// provider and approver are optional ("Don't know? No problem — we'll reach
// out"). Owner: the dealer's company owner, else the feed_support team member
// with the fewest open orders, who gets a task. Fire-and-forget: it never
// blocks or fails the upgrade.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createAdminSupabaseClient } from "@/lib/db";
import { createFeedOrder } from "./orders";

export const isAutomatic = (accountType: string | null | undefined) => /^automatic/i.test((accountType ?? "").trim());

/** Provider name from the dealer form → a feed_supplier company (settings.platform_provider, else name). */
export async function supplierForProvider(admin: any, provider: string | null): Promise<string | null> {
  const p = (provider ?? "").trim();
  if (!p || /^(other|unknown|don'?t know|manual)$/i.test(p)) return null;
  const { data: bySetting } = await admin.from("crm_feed_supplier_settings").select("company_id").ilike("platform_provider", p).limit(1);
  if (bySetting?.length) return bySetting[0].company_id;
  const { data: byName } = await admin.from("crm_companies").select("id").eq("kind", "feed_supplier").ilike("name", p).limit(1);
  return byName?.[0]?.id ?? null;
}

export function fireSelfServeFeedOrder(input: {
  dealerUuid: string; previousAccountType: string | null; newAccountType: string | null;
  provider: string | null; approverName: string | null; approverEmail: string | null; feedExisting?: boolean;
}): void {
  if (isAutomatic(input.previousAccountType) || !isAutomatic(input.newAccountType) || input.feedExisting) return;
  void (async () => {
    const admin = createAdminSupabaseClient() as any;
    const { data: co } = await admin.from("crm_companies").select("id").eq("dealer_id", input.dealerUuid).maybeSingle();
    if (!co) return;   // migration 179 not applied / company row missing
    const supplier = await supplierForProvider(admin, input.provider);
    await createFeedOrder(admin, {
      dealerCompanyId: co.id, supplierCompanyId: supplier, source: "self_serve",
      approverName: input.approverName, approverEmail: input.approverEmail,
      notes: `Self-serve upgrade to ${input.newAccountType}${input.provider ? ` · provider picked: ${input.provider}` : " · provider not given"}`,
    });
  })().catch((e) => console.error("[crm-feeds] self-serve order:", e instanceof Error ? e.message : e));
}
