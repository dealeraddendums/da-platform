// 4.0 lockout hook — sets the legacy platform's per-dealership `migrated_to_v5`
// flag when a dealer migrates (and clears it on rollback / un-force), so the
// dealer's 4.0 login redirects to /welcome automatically instead of an operator
// flipping the 4.0 admin toggle by hand.
//
// HARD RULE: 5.0 NEVER writes Aurora. The flag write happens inside 4.0 via a
// 4.0-owned endpoint; this module only calls it, authenticated with a shared key.
//
// 4.0 endpoint (BUILT + verified against prod 2026-09-27):
//   POST {LEGACY_LOCKOUT_URL}          (https://dealeraddendums.com/app/api/dealer/migrated-flag)
//   Header: X-API-Key: {LEGACY_LOCKOUT_SECRET}
//   Body:   { "dealer_id": "<legacy 4.0 DEALER_ID>", "migrated_to_v5": true|false }
//   200 {ok:true,dealer_found:true,migrated_to_v5} · 404 {ok:false,dealer_found:false}
//   400 · 401 {error:"unauthorized"} · 429 (60/min per IP)
//
// ── Two corrections made 2026-09-27 after verifying against the live endpoint ──
//  1. The header is `X-API-Key`. This module previously sent `X-Webhook-Secret`,
//     which the endpoint answers 401 to — so every lockout call had been failing
//     (silently, into legacy_lockout_pending).
//  2. The flag is keyed on `dealers.dealer_id`, NOT `inventory_dealer_id`.
//     Measured against Aurora dealer_dim across all 2,044 4.0-origin dealers:
//     dealer_id resolves 1,888; inventory_dealer_id resolves 1,  and for
//     Greenway CDJR - Orlando the two columns point at DIFFERENT real
//     dealerships (inventory_dealer_id "MP3678-old" is Greenway Dodge Chrysler
//     Jeep Ram) — keying on inventory_dealer_id would have locked out an
//     innocent dealership. A dealer whose dealer_id isn't in Aurora gets a 404,
//     which is a hard error everywhere (never a silent wrong-dealer write).

import type { SupabaseClient } from "@supabase/supabase-js";
import { fireAndForget } from "@/lib/billing-sync";

export interface LockoutDealer {
  id: string;                        // dealers.id UUID
  dealer_id: string;                 // 5.0 text id — ALSO the legacy 4.0 DEALER_ID
  name: string;
  /** Legacy feed id. NOT the lockout key — kept only for logging/diagnostics. */
  inventory_dealer_id?: string | null;
}

export interface LockoutResult {
  ok: boolean;
  /** HTTP status, when we got one. */
  status?: number;
  /** 4.0 says the DEALER_ID doesn't exist — a mapping error, never retry blindly. */
  dealerNotFound?: boolean;
  detail: string;
}

export function lockoutConfigured(): boolean {
  return Boolean(process.env.LEGACY_LOCKOUT_URL && process.env.LEGACY_LOCKOUT_SECRET);
}

/**
 * One awaited call against the 4.0 endpoint. Never throws — returns a structured
 * result so the caller decides whether to abort (force flow) or mark pending
 * (fire-and-forget migrate paths).
 */
export async function setLegacyMigratedFlag(legacyDealerId: string, migrated: boolean): Promise<LockoutResult> {
  if (!lockoutConfigured()) {
    return { ok: false, detail: "4.0 lockout endpoint not configured (LEGACY_LOCKOUT_URL/LEGACY_LOCKOUT_SECRET)" };
  }
  const id = (legacyDealerId ?? "").trim();
  if (!id) return { ok: false, detail: "no legacy DEALER_ID — cannot key the 4.0 dealership" };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(process.env.LEGACY_LOCKOUT_URL!, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": process.env.LEGACY_LOCKOUT_SECRET! },
      body: JSON.stringify({ dealer_id: id, migrated_to_v5: migrated }),
      signal: controller.signal,
    });
    let body: { ok?: boolean; dealer_found?: boolean; error?: string } | null = null;
    try { body = await res.json(); } catch { /* non-JSON */ }

    if (res.ok && body?.ok === true) {
      return { ok: true, status: res.status, detail: `4.0 migrated_to_v5=${migrated ? "Yes" : "No"} for ${id}` };
    }
    if (res.status === 404 || body?.dealer_found === false) {
      return { ok: false, status: 404, dealerNotFound: true, detail: `4.0 has no dealership with DEALER_ID "${id}" — mapping is wrong` };
    }
    return { ok: false, status: res.status, detail: `4.0 lockout endpoint HTTP ${res.status}${body?.error ? ` (${body.error})` : ""}` };
  } catch (e) {
    const msg = e instanceof Error && e.name === "AbortError" ? "timed out" : e instanceof Error ? e.message : String(e);
    return { ok: false, detail: `4.0 lockout endpoint unreachable: ${msg}` };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Fire-and-forget 4.0 lockout set/clear for one dealer (the existing migrate
 * paths). Success stamps `legacy_lockout_at` and clears `legacy_lockout_pending`;
 * any failure sets `legacy_lockout_pending` for the manual 4.0-toggle path. The
 * migrate is NEVER blocked on this. The FORCE flow does not use this — it awaits
 * setLegacyMigratedFlag directly so it can abort.
 */
export function fireLegacyLockout(admin: SupabaseClient, dealer: LockoutDealer, migrated: boolean): void {
  fireAndForget(async () => {
    const result = await setLegacyMigratedFlag(dealer.dealer_id, migrated);
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
    payload: { legacy_dealer_id: dealer.dealer_id, migrated_to_v5: migrated },
  });
}
