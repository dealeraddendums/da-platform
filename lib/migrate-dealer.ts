// Shared dealer-migration writes — the CANONICAL field set used by the
// self-serve /api/migrate/confirm flow and the group-level
// /api/migration/migrate-group flow. Keep both callers on these helpers so the
// two paths can't drift.
import type { SupabaseClient } from "@supabase/supabase-js";
import { fireDealerReliable } from "@/lib/sync-hubspot";
import { fireConversionWebhook } from "@/lib/marketing-webhook";
import { fireAndForget } from "@/lib/billing-sync";
import { boxConfigured, createDealerFolder } from "@/lib/box";

/** account_type Paid tier for a migrating dealer, from its inventory setup. */
export function paidTierFor(dms: boolean | null, provider: string | null): string {
  if (dms) return "Automatic DMS";
  if (provider && provider.trim()) return "Automatic Web";
  return "Manual";
}

/** A safe FUTURE next-invoice date: keep the existing one if it's already in
 *  the future, else push ~one cycle out (30 days) so the billing cron doesn't
 *  fire an immediate catch-up invoice on migration day. */
export function futureNextInvoice(existing: string | undefined, now: number): string {
  if (existing) { const t = Date.parse(existing); if (Number.isFinite(t) && t > now) return existing; }
  return new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();
}

export interface MigratableDealer {
  id: string;
  dealer_id: string;
  name: string;
  inventory_provider: string | null;
  inventory_provider_is_dms: boolean | null;
  box_folder_id: string | null;
}

/**
 * Flip one dealer to migrated: the dealers-row write (migration_status,
 * Paid account_type, converted_at, downgraded_at reset, billing_cutover_at),
 * Box folder provision (fire-and-forget), and the HubSpot lifecycle +
 * marketing conversion webhooks. Billing activation is NOT here — the two
 * flows gate it differently (MIGRATION_AUTO_ACTIVATE vs the operator's
 * explicit confirm checkbox).
 *
 * `billingCutover` stamps billing_cutover_at (da-billing is now the system of
 * record for this dealer's invoicing).
 */
export async function migrateDealerRecord(
  admin: SupabaseClient,
  dealer: MigratableDealer,
  opts: { nowIso: string; hubspotContext: string; extraPatch?: Record<string, unknown> },
): Promise<{ ok: boolean; error?: string; plan: string }> {
  const plan = paidTierFor(dealer.inventory_provider_is_dms, dealer.inventory_provider);
  const patch: Record<string, unknown> = {
    migration_status: "migrated",
    account_type: plan,
    converted_at: opts.nowIso,
    downgraded_at: null,
    billing_cutover_at: opts.nowIso,
    ...(opts.extraPatch ?? {}),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin as any).from("dealers").update(patch).eq("id", dealer.id);
  if (error) return { ok: false, error: error.message, plan };

  // Box folder — ETL-created legacy dealers never got one; non-fatal.
  if (boxConfigured() && !dealer.box_folder_id) {
    fireAndForget(async () => {
      const folderId = await createDealerFolder(dealer.name);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: boxErr } = await (admin as any)
        .from("dealers")
        .update({ box_folder_id: folderId })
        .eq("id", dealer.id)
        .is("box_folder_id", null);
      if (boxErr) throw new Error(`dealers update failed: ${boxErr.message} (folder ${folderId})`);
    }, {
      event: "box.folder.create",
      dealerId: dealer.id,
      payload: { dealerName: dealer.name, entity: "dealer", source: "migrate-dealer" },
    });
  }

  fireDealerReliable(dealer.id, opts.hubspotContext);
  fireConversionWebhook({ dealerId: dealer.dealer_id, convertedAt: opts.nowIso, plan });
  return { ok: true, plan };
}
