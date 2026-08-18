// Non-blocking wrapper around external billing/XPS calls. Every call goes
// through `runSync` so failures land in billing_sync_errors instead of
// surfacing to the user. The wrapper itself never throws.

import { createAdminSupabaseClient } from "@/lib/db";

export type BillingSyncEvent =
  | "billing.customer.create"
  | "billing.template.create"
  | "billing.template.upsert"
  | "billing.template.append"
  | "billing.customer.archive"
  | "billing.customer.unarchive"
  | "billing.dealer.rename"
  | "billing.dealer.rename.group_template"
  | "billing.group.rename"
  | "xps.order.create"
  | "xps.shipment.poll"
  | "box.folder.create"
  | "legacy.lockout.set";

export interface RunSyncOptions {
  event: BillingSyncEvent;
  payload?: Record<string, unknown>;
  dealerId?: string | null;
  groupId?: string | null;
}

/**
 * Fire-and-forget wrapper. The returned promise always resolves; never
 * rejects. On failure, writes a row to billing_sync_errors so super_admin
 * can review and retry. Callers can `await` this if they need to surface
 * a success/fail to the user, but the call site convention is `void`.
 */
export async function runSync<T>(
  fn: () => Promise<T>,
  opts: RunSyncOptions,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[billing-sync] ${opts.event} failed:`, message);
    try {
      const admin = createAdminSupabaseClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any).from("billing_sync_errors").insert({
        event_type: opts.event,
        payload: opts.payload ?? {},
        error_message: message,
        dealer_id: opts.dealerId ?? null,
        group_id: opts.groupId ?? null,
      });
    } catch (logErr) {
      console.error("[billing-sync] failed to log error:", logErr instanceof Error ? logErr.message : logErr);
    }
    return { ok: false, error: message };
  }
}

/**
 * Convenience: fire-and-forget. Use when the user-facing flow shouldn't
 * wait at all — e.g. ETL hooks, archive on deactivate.
 */
export function fireAndForget<T>(fn: () => Promise<T>, opts: RunSyncOptions): void {
  void runSync(fn, opts);
}
