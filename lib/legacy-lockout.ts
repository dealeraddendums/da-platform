// 4.0 lockout hook (2026-08-18) — sets the legacy platform's per-dealership
// `migrated_to_v5` flag when a dealer migrates (and clears it on rollback), so
// the dealer's 4.0 login redirects to /welcome automatically instead of an
// operator flipping the 4.0 admin toggle by hand.
//
// HARD RULE: 5.0 NEVER writes Aurora. The flag write happens inside 4.0 via a
// 4.0-owned endpoint; this module only calls it, authenticated with a shared
// secret (same pattern as the billing cache-invalidate webhook).
//
// Expected 4.0 endpoint (spec: suite root `spec-shawon-40-lockout-endpoint.md`):
//   POST {LEGACY_LOCKOUT_URL}
//   Header: X-Webhook-Secret: {LEGACY_LOCKOUT_SECRET}
//   Body:   { "dealer_id": "<legacy DEALER_ID>", "migrated_to_v5": true|false }
//   2xx = flag set. Anything else = failure.
//
// Until that endpoint exists (env vars unset), every migrate marks the dealer
// `legacy_lockout_pending` so the operator knows to flip the 4.0 toggle
// manually — the migrate itself is NEVER blocked on this.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fireAndForget } from "@/lib/billing-sync";

export interface LockoutDealer {
  id: string;                        // dealers.id UUID
  dealer_id: string;                 // 5.0 text id (logging)
  name: string;
  /** The legacy 4.0 DEALER_ID the flag is keyed on. */
  inventory_dealer_id?: string | null;
}

function lockoutConfigured(): boolean {
  return Boolean(process.env.LEGACY_LOCKOUT_URL && process.env.LEGACY_LOCKOUT_SECRET);
}

/** One attempt against the 4.0 endpoint. Never throws. */
async function callLegacyLockout(legacyDealerId: string, migrated: boolean): Promise<{ ok: boolean; detail: string }> {
  if (!lockoutConfigured()) return { ok: false, detail: "4.0 lockout endpoint not configured (LEGACY_LOCKOUT_URL/SECRET) — Shawon endpoint pending; flip the 4.0 admin toggle manually" };
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 20_000);
    let res: Response;
    try {
      res = await fetch(process.env.LEGACY_LOCKOUT_URL!, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Webhook-Secret": process.env.LEGACY_LOCKOUT_SECRET! },
        body: JSON.stringify({ dealer_id: legacyDealerId, migrated_to_v5: migrated }),
        signal: controller.signal,
      });
    } finally { clearTimeout(t); }
    if (res.ok) return { ok: true, detail: `4.0 migrated_to_v5=${migrated ? "Yes" : "No"} (HTTP ${res.status})` };
    return { ok: false, detail: `4.0 lockout endpoint HTTP ${res.status}` };
  } catch (e) {
    const msg = e instanceof Error && e.name === "AbortError" ? "timed out" : e instanceof Error ? e.message : String(e);
    return { ok: false, detail: `4.0 lockout endpoint unreachable: ${msg}` };
  }
}

/**
 * Fire-and-forget 4.0 lockout set/clear for one dealer. Success stamps
 * `legacy_lockout_at` and clears `legacy_lockout_pending`; failure (or missing
 * env/endpoint/legacy id) sets `legacy_lockout_pending` for the manual path.
 * Rollback (`migrated=false`) clears `legacy_lockout_at` on success. A missing
 * migration-146 column degrades to a log line — never breaks the migrate.
 */
export function fireLegacyLockout(admin: SupabaseClient, dealer: LockoutDealer, migrated: boolean): void {
  fireAndForget(async () => {
    const legacyId = (dealer.inventory_dealer_id ?? "").trim();
    let result: { ok: boolean; detail: string };
    if (!legacyId) {
      result = { ok: false, detail: "no inventory_dealer_id — cannot key the 4.0 dealership" };
    } else {
      result = await callLegacyLockout(legacyId, migrated);
    }

    const patch = result.ok
      ? { legacy_lockout_at: migrated ? new Date().toISOString() : null, legacy_lockout_pending: false }
      : { legacy_lockout_pending: true };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (admin as any).from("dealers").update(patch).eq("id", dealer.id);
    if (error && !/legacy_lockout|column/i.test(error.message)) {
      console.error(`[legacy-lockout] tracking update failed for ${dealer.dealer_id}:`, error.message);
    }
    console.log(`[legacy-lockout] dealer=${dealer.dealer_id} (${dealer.name}) set=${migrated} → ${result.ok ? "OK" : "PENDING"} — ${result.detail}`);
    if (!result.ok) throw new Error(result.detail); // routes to fireAndForget's error ledger
  }, {
    event: "legacy.lockout.set",
    dealerId: dealer.id,
    payload: { legacy_dealer_id: dealer.inventory_dealer_id ?? null, migrated_to_v5: migrated },
  });
}
