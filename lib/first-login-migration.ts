// First-login auto-migration (Allan, 2026-10-07).
//
// The intended flow: a group admin sets up a dealer's 5.0 account (operator
// access — never gated), creates the dealer's OWN user with +Add User, and asks
// that person to log in. That person's first successful 5.0 login IS the
// migration: the dealer flips to migrated, 4.0 locks the dealer out, and the
// user lands on the 5.0 dashboard with a one-time "you're live" notice.
//
// This removes the catch-22 in POST /api/auth/login: a correct 5.0 password on
// an unmigrated dealer used to be discarded in favor of the 4.0 handoff — and
// the 4.0 password is a different one, so the user was told "wrong password".
//
// WHO can trigger it: only a real credential verification by the dealer's own
// user — the password route, passkey completion, and the emailed-code form.
// Impersonation and ghost sessions are minted server-side and never pass
// through any of those, so operators can't trigger it by looking at a dealer.
// (A group admin who signs in WITH the dealer user's credentials does trigger
// it — they should hand the credentials over, not test-login as the user.)
//
// GUARD (Allan: guard on): the dealer must be provisioned — synced or staged
// (pending/invited) AND have a default addendum template. An unconfigured
// dealer's user still logs in (soft gate) but nothing migrates, so a premature
// login can't lock an unconfigured dealer out of 4.0.
//
// BILLING (Allan: group billing queued, never auto): a group-billed dealer's
// login never activates the GROUP template (that would start invoicing the
// whole group off one member's login). Self-billed follows /api/migrate/confirm:
// already-live → no-op; MIGRATION_AUTO_ACTIVATE → activate with a future date;
// otherwise queued for operator review.
//
// 4.0 LOCKOUT: called (awaited, bounded) after the 5.0 write. The dealer is
// written legacy_lockout_pending=true WITH the migration, and only a confirmed
// 4.0 success clears it — so a timeout, a 4.0 hiccup, or even a crash leaves a
// pending row the daily sweep (retryPendingLegacyLockouts) finishes. Migrated
// on 5.0 but not yet locked on 4.0 is a safe dual-run state.
//
// HALF STATES: the migration write is ONE atomic row update (only while the
// dealer is still unmigrated). If it fails nothing changed and the caller falls
// back to today's behavior. Everything after it is best-effort and tracked.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabaseClient, fireWrite } from "@/lib/db";
import { DEALER_ROLES, isDealerMigratedOnV5 } from "@/lib/v5-usable";
import { migrateDealerRecord, futureNextInvoice } from "@/lib/migrate-dealer";
import { setLegacyMigratedFlag } from "@/lib/legacy-lockout";
import { billingConfigured, getTemplate, activateTemplate } from "@/lib/billing";
import { sendMandrillEmail } from "@/lib/mandrill";

/** Short-lived, readable-by-the-page cookie that shows the one-time notice. */
export const LIVE_ON_5_COOKIE = "da_live_on_5";
export const LIVE_ON_5_COOKIE_MAX_AGE = 10 * 60; // seconds

/** Login waits at most this long for 4.0 before landing the user anyway. */
const LOCKOUT_WAIT_MS = 6_000;

const AUTO_ACTIVATE =
  process.env.MIGRATION_AUTO_ACTIVATE === "1" || process.env.MIGRATION_AUTO_ACTIVATE === "true";

/** Roles whose login migrates their dealer. dealer_restricted is read-only
 *  staff, never the person a group admin hands a dealer over to. */
const TRIGGER_ROLES = new Set(["dealer_admin", "dealer_user"]);

type Admin = SupabaseClient;

interface DealerRow {
  id: string;
  dealer_id: string;
  name: string;
  active: boolean | null;
  migration_status: string | null;
  is_native: boolean | null;
  last_synced_at: string | null;
  group_id: string | null;
  subscription_billed_to: string | null;
  billing_customer_id: string | null;
  inventory_provider: string | null;
  inventory_provider_is_dms: boolean | null;
  box_folder_id: string | null;
  freshbooks_stopped_at: string | null;
  inventory_dealer_id: string | null;
}

export type FirstLoginOutcome =
  /** The dealer is (now) usable on 5.0 — finish the 5.0 login. */
  | { usable: true; migratedNow: boolean; dealerName: string | null; lockout?: "ok" | "pending" }
  /** Not a trigger (operator, unprovisioned, inactive, …) or the write failed. */
  | { usable: false; reason: string };

/**
 * Called right after a real credential verification. Never throws. On
 * `usable:false` the caller behaves exactly as before this feature existed.
 */
export async function migrateOnFirstDealerLogin(args: {
  userId: string;
  email: string | null;
  via: "password" | "passkey" | "otp";
  admin?: Admin;
}): Promise<FirstLoginOutcome> {
  try {
    return await run(args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[first-login-migration] unexpected error user=${args.userId}:`, msg);
    return { usable: false, reason: `error: ${msg}` };
  }
}

async function run(args: { userId: string; email: string | null; via: string; admin?: Admin }): Promise<FirstLoginOutcome> {
  const admin = (args.admin ?? createAdminSupabaseClient()) as Admin;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = admin as any;

  const { data: prof } = await a.from("profiles")
    .select("role, dealer_id, active").eq("id", args.userId)
    .maybeSingle() as { data: { role: string | null; dealer_id: string | null; active: boolean | null } | null };
  if (!prof?.role || !DEALER_ROLES.has(prof.role)) return { usable: false, reason: "not a dealer role" };
  if (!prof.dealer_id) return { usable: false, reason: "no dealer on profile" };

  const { data: dealer } = await a.from("dealers")
    .select("id, dealer_id, name, active, migration_status, is_native, last_synced_at, group_id, subscription_billed_to, billing_customer_id, inventory_provider, inventory_provider_is_dms, box_folder_id, freshbooks_stopped_at, inventory_dealer_id")
    .eq("dealer_id", prof.dealer_id)
    .maybeSingle() as { data: DealerRow | null };
  if (!dealer) return { usable: false, reason: "dealer row not found" };

  // Already usable (migrated/native) — a normal login, no banner.
  if (isDealerMigratedOnV5(dealer)) return { usable: true, migratedNow: false, dealerName: dealer.name };

  if (!TRIGGER_ROLES.has(prof.role)) return { usable: false, reason: `role ${prof.role} does not trigger migration` };
  if (prof.active === false) return { usable: false, reason: "user inactive" };
  if (dealer.active === false) return { usable: false, reason: "dealer inactive" };

  const ready = await isProvisioned(a, dealer);
  if (!ready.ok) {
    console.log(`[first-login-migration] NOT migrating dealer=${dealer.dealer_id} (${dealer.name}) on ${args.via} login by ${args.email}: ${ready.reason}`);
    return { usable: false, reason: `not provisioned: ${ready.reason}` };
  }

  // ── 1. The 5.0 migration — ONE atomic write (only while still unmigrated) ──
  const nowIso = new Date().toISOString();
  const migrated = await migrateDealerRecord(admin, dealer, {
    nowIso,
    hubspotContext: "first dealer login — upgrade to Paid (Customer)",
    skipLegacyLockout: true,          // driven below, awaited + tracked
    onlyIfNotMigrated: true,
    extraPatch: { legacy_lockout_pending: true },
  });
  if (!migrated.ok) {
    if (migrated.alreadyMigrated) {
      // Another worker/user migrated it a moment ago — this login is just a login.
      return { usable: true, migratedNow: false, dealerName: dealer.name };
    }
    console.error(`[first-login-migration] migration write FAILED dealer=${dealer.dealer_id}: ${migrated.error} — falling back, nothing changed`);
    return { usable: false, reason: `migration write failed: ${migrated.error}` };
  }

  // ── 2. 4.0 lockout (bounded wait; tracked either way) ──────────────────────
  const lockoutDone = setLegacyMigratedFlag(dealer.dealer_id, true).then(async (r) => {
    if (r.ok) {
      await a.from("dealers").update({ legacy_lockout_at: new Date().toISOString(), legacy_lockout_pending: false }).eq("id", dealer.id);
    }
    console.log(`[first-login-migration] 4.0 lockout dealer=${dealer.dealer_id} → ${r.ok ? "OK" : "PENDING (daily sweep retries)"} — ${r.detail}`);
    return r.ok ? "ok" as const : "pending" as const;
  }).catch((e) => {
    console.error(`[first-login-migration] 4.0 lockout error dealer=${dealer.dealer_id}:`, e instanceof Error ? e.message : e);
    return "pending" as const;
  });
  const lockout = await Promise.race([
    lockoutDone,
    new Promise<"pending">((r) => setTimeout(() => r("pending"), LOCKOUT_WAIT_MS)),
  ]);

  // ── 3. Billing (never the group template) ──────────────────────────────────
  const billing = await applyBilling(a, dealer);

  // ── 4. Log + team alert ─────────────────────────────────────────────────────
  const notes = `first-login auto-migration — ${args.via} login by ${args.email ?? args.userId}; plan ${migrated.plan}; billing ${billing.state} (${billing.detail}); 4.0 lockout ${lockout}`;
  fireWrite(a.from("migration_log").insert({
    dealer_id: dealer.id,
    event: "migrated",
    performed_by: args.userId,
    billing_customer_id: billing.customerId,
    notes,
  }), "migration_log first-login migrated");
  console.log(`[first-login-migration] MIGRATED dealer=${dealer.dealer_id} (${dealer.name}) uuid=${dealer.id} — ${notes}`);

  const fbLine = dealer.freshbooks_stopped_at
    ? "already handled (paused at invite)"
    : "<strong>queued — stop their FreshBooks recurring profile manually</strong> (do not dry-run-then-live)";
  void sendMandrillEmail({
    subject: `✅ First-login migration — ${dealer.name}`,
    from_email: "noreply@dealeraddendums.com",
    from_name: "DealerAddendums",
    to: [{ email: "support@dealeraddendums.com", name: "DA Support" }],
    html: `<p><strong>${dealer.name}</strong> (${dealer.dealer_id}) migrated to 5.0 on its first dealer-user login (${args.email ?? args.userId}, via ${args.via}).</p>
<p>Plan: ${migrated.plan}<br>Billing: <strong>${billing.state}</strong> — ${billing.detail}<br>4.0 lockout: <strong>${lockout === "ok" ? "set" : "PENDING — retried by the daily sweep"}</strong><br>FreshBooks recurring-stop: ${fbLine}</p>`,
  }).catch((e) => console.error("[first-login-migration] alert email failed:", e instanceof Error ? e.message : e));

  return { usable: true, migratedNow: true, dealerName: dealer.name, lockout };
}

/** The readiness guard: synced or staged, AND a default addendum template. */
async function isProvisioned(a: any, d: DealerRow): Promise<{ ok: boolean; reason: string }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const synced = !!d.last_synced_at || d.migration_status === "pending" || d.migration_status === "invited";
  if (!synced) return { ok: false, reason: "never synced or staged" };
  const { data: s } = await a.from("dealer_settings")
    .select("default_addendum_new, default_addendum_used, default_addendum_cpo")
    .eq("dealer_id", d.dealer_id).maybeSingle() as
    { data: { default_addendum_new: string | null; default_addendum_used: string | null; default_addendum_cpo: string | null } | null };
  if (!s || !(s.default_addendum_new || s.default_addendum_used || s.default_addendum_cpo)) {
    return { ok: false, reason: "no default addendum template" };
  }
  return { ok: true, reason: "synced + template" };
}

async function applyBilling(a: any, d: DealerRow): Promise<{ state: string; detail: string; customerId: string | null }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const groupBilled = d.subscription_billed_to === "group";
  let customerId = d.billing_customer_id;
  if (groupBilled && d.group_id) {
    const { data: g } = await a.from("groups").select("billing_customer_id").eq("id", d.group_id).maybeSingle() as
      { data: { billing_customer_id: string | null } | null };
    customerId = g?.billing_customer_id ?? null;
  }
  if (!billingConfigured() || !customerId) {
    return { state: "no-customer", detail: groupBilled ? "group has no billing customer" : "dealer has no billing customer", customerId };
  }
  let tmpl: Awaited<ReturnType<typeof getTemplate>> = null;
  try { tmpl = await getTemplate(customerId); } catch { /* treated as not live */ }
  if (tmpl?.active === true) {
    return { state: "already-live", detail: `${groupBilled ? "group" : "dealer"} template already live — nothing changed`, customerId };
  }
  if (groupBilled) {
    return { state: "review-queued", detail: `group customer ${customerId} — group template NOT activated from a member login; operator review`, customerId };
  }
  if (AUTO_ACTIVATE) {
    try {
      const next = futureNextInvoice(tmpl?.nextInvoiceDate, Date.now());
      await activateTemplate(customerId, next);
      return { state: "activated", detail: `active=true, nextInvoiceDate=${next}`, customerId };
    } catch (e) {
      return { state: "error", detail: e instanceof Error ? e.message : String(e), customerId };
    }
  }
  return { state: "review-queued", detail: `customer ${customerId} — activation pending operator review (MIGRATION_AUTO_ACTIVATE off)`, customerId };
}

/**
 * Daily self-heal (runs inside the migration follow-ups cron): any MIGRATED
 * dealer still flagged legacy_lockout_pending gets the 4.0 call again. A 404
 * (4.0 doesn't know the DEALER_ID) is a mapping error — logged, left pending
 * for a human, never "fixed" by guessing another id.
 */
export async function retryPendingLegacyLockouts(admin?: Admin): Promise<{ tried: number; ok: number; failed: string[] }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = (admin ?? createAdminSupabaseClient()) as any;
  const { data, error } = await a.from("dealers")
    .select("id, dealer_id, name")
    .eq("migration_status", "migrated")
    .eq("legacy_lockout_pending", true)
    .limit(200) as { data: { id: string; dealer_id: string; name: string }[] | null; error: { message: string } | null };
  if (error) { console.error("[lockout-sweep] read failed:", error.message); return { tried: 0, ok: 0, failed: [] }; }
  const out = { tried: 0, ok: 0, failed: [] as string[] };
  for (const d of data ?? []) {
    out.tried++;
    const r = await setLegacyMigratedFlag(d.dealer_id, true);
    if (r.ok) {
      out.ok++;
      await a.from("dealers").update({ legacy_lockout_at: new Date().toISOString(), legacy_lockout_pending: false }).eq("id", d.id);
    } else {
      out.failed.push(`${d.dealer_id} (${d.name}): ${r.detail}`);
    }
  }
  console.log(`[lockout-sweep] tried=${out.tried} ok=${out.ok} failed=${out.failed.length}${out.failed.length ? " — " + out.failed.join(" | ") : ""}`);
  return out;
}
