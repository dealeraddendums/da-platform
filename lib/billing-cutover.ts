// Invite-time billing cutover (2026-08-17) — fired after a SELF-BILLED dealer's
// FIRST migration invite is successfully sent:
//
// ORDERING (hardened 2026-08-19 — double-bill exposure on Myrtle Beach
// Hyundai, where go-live succeeded but the FreshBooks pause failed):
//   1. PRE-FLIGHT da-billing (non-mutating): customer linked + template staged.
//      If 5.0 billing cannot go live, FreshBooks is NOT touched — a dealer must
//      never end up billing nowhere.
//   2. PAUSE FreshBooks FIRST: proxied to the ETL box's key-gated
//      POST /freshbooks/recurring-pause (the box owns Aurora + the FB bearer).
//      WRITE-BUT-NEVER-REFRESH: an expired/missing bearer or any failure DEFERS
//      the whole cutover — da-billing stays in Setup Mode (no double-billing),
//      a support@ alert fires, and the cutover retries on the next Resend.
//      Never a token refresh. A confirmed pause (or a profile that no longer
//      exists in FreshBooks) stamps dealers.freshbooks_stopped_at. "No
//      RECURE_ID on file" counts as nothing-to-pause and does not block.
//   3. da-billing go-live: take the customer out of Setup Mode + activate the
//      recurring template, preserving a FUTURE nextInvoiceDate (no catch-up
//      invoice). Idempotent — an already-live customer is a no-op. Success
//      stamps dealers.billing_cutover_at. A go-live failure AFTER a confirmed
//      pause (rare — pre-flight already validated) is a billing-NOWHERE state
//      and alerts CRITICALLY; recovery is da-billing "Go Live" (or Return to
//      Setup + resume the FB profile).
//
// GROUP-BILLED dealers never reach this — their cutover stays on "Migrate
// group". Neither step throws: the invite is already sent, so each step
// reports its own ✓/pending outcome for the console.

import type { SupabaseClient } from "@supabase/supabase-js";
import { billingConfigured, getCustomer, getTemplate, activateTemplate, setBillingState } from "@/lib/billing";
import { futureNextInvoice } from "@/lib/migrate-dealer";
import { invalidateBillingStatusCache } from "@/lib/print-eligibility";
import { sendMandrillEmail } from "@/lib/mandrill";
import { fireWrite } from "@/lib/db";

export interface BillingCutoverResult {
  /** 2a outcome, human-readable. ok=true covers "activated" and "already live". */
  billing: string;
  billingOk: boolean;
  /** 2b outcome. ok=true covers "paused", "already paused", "profile gone". */
  freshbooks: string;
  freshbooksOk: boolean;
}

interface CutoverDealer {
  id: string;
  dealer_id: string;
  name: string;
  inventory_dealer_id: string | null;
  billing_customer_id: string | null;
}

const supportAlert = (subject: string, html: string) =>
  sendMandrillEmail({
    subject, from_email: "noreply@dealeraddendums.com", from_name: "DealerAddendums",
    to: [{ email: "support@dealeraddendums.com", name: "DA Support" }], html,
  }).catch((e) => console.error("[billing-cutover] alert email failed:", e instanceof Error ? e.message : e));

/** Stamp billing_cutover_at only if not already stamped (idempotent marker). */
async function stampCutoverAt(admin: SupabaseClient, dealerUuid: string, nowIso: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin as any)
    .from("dealers")
    .update({ billing_cutover_at: nowIso })
    .eq("id", dealerUuid)
    .is("billing_cutover_at", null);
  if (error) console.error("[billing-cutover] billing_cutover_at stamp failed:", error.message);
}

/** 2a — da-billing go-live for the dealer's OWN customer. */
async function goLiveDaBilling(
  admin: SupabaseClient,
  dealer: CutoverDealer,
  nowIso: string,
): Promise<{ ok: boolean; detail: string }> {
  if (!billingConfigured()) return { ok: false, detail: "billing API not configured" };
  const customerId = dealer.billing_customer_id;
  if (!customerId) return { ok: false, detail: "no da-billing customer linked" };
  try {
    const [customer, tmpl] = await Promise.all([getCustomer(customerId), getTemplate(customerId)]);
    if (!tmpl) return { ok: false, detail: `customer ${customerId} has no recurring template staged` };
    const inSetup = customer?.billingState === "setup";
    if (tmpl.active === true && !inSetup) {
      // Already fully live — idempotent no-op, but the cutover marker still applies.
      await stampCutoverAt(admin, dealer.id, nowIso);
      invalidateBillingStatusCache(customerId);
      return { ok: true, detail: "already live (no change)" };
    }
    if (inSetup || customer?.billingState == null) await setBillingState(customerId, "active");
    const next = futureNextInvoice(tmpl.nextInvoiceDate ?? undefined, Date.parse(nowIso));
    if (tmpl.active !== true) await activateTemplate(customerId, next);
    await stampCutoverAt(admin, dealer.id, nowIso);
    invalidateBillingStatusCache(customerId);
    return { ok: true, detail: `activated — nextInvoiceDate=${next.slice(0, 10)}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** FreshBooks recurring pause via the ETL box (write-but-never-refresh).
 *  status: "paused" = confirmed terminal stop (paused / already / profile gone,
 *  freshbooks_stopped_at stamped) · "none" = nothing to pause (no RECURE_ID /
 *  dealer not in Aurora — go-live may proceed, nothing stamped) · "failed" =
 *  pause NOT confirmed (bearer missing/expired, FB/ETL error) — go-live must
 *  NOT proceed. */
async function pauseFreshBooks(
  admin: SupabaseClient,
  dealer: CutoverDealer,
  nowIso: string,
): Promise<{ status: "paused" | "none" | "failed"; detail: string }> {
  const etlUrl = process.env.ETL_SYNC_URL;
  const etlKey = process.env.ETL_SYNC_API_KEY;
  if (!etlUrl || !etlKey) return { status: "failed", detail: "ETL_SYNC_URL / ETL_SYNC_API_KEY not configured" };
  if (!dealer.inventory_dealer_id) return { status: "failed", detail: "no inventory_dealer_id (cannot resolve Aurora RECURE_ID)" };
  const base = etlUrl.replace(/\/sync\/?$/, "");
  try {
    const controller = new AbortController();
    // 75s: covers the ETL box's one 15s re-read of fb_keys when the bearer is
    // mid-rotation, plus the read-PUT-confirm round trips.
    const t = setTimeout(() => controller.abort(), 75_000);
    let res: Response;
    try {
      res = await fetch(`${base}/freshbooks/recurring-pause`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": etlKey },
        body: JSON.stringify({ inventory_dealer_id: dealer.inventory_dealer_id, action: "pause" }),
        signal: controller.signal,
      });
    } finally { clearTimeout(t); }
    const j = (await res.json().catch(() => null)) as
      | { ok?: boolean; state?: string; profile_id?: string; reason?: string; error?: string }
      | null;
    if (!res.ok || !j) return { status: "failed", detail: `ETL box HTTP ${res.status}` };
    if (j.ok) {
      // Confirmed terminal state: paused / already paused / profile gone in FB.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (admin as any)
        .from("dealers")
        .update({ freshbooks_stopped_at: nowIso })
        .eq("id", dealer.id)
        .is("freshbooks_stopped_at", null);
      if (error) console.error("[billing-cutover] freshbooks_stopped_at stamp failed:", error.message);
      const what = j.state === "already" ? "already paused"
        : j.state === "not_found" || j.state === "deleted" ? `profile ${j.profile_id} no longer exists in FreshBooks`
        : `paused (profile ${j.profile_id})`;
      return { status: "paused", detail: what };
    }
    // Nothing to pause — no individual recurring profile exists for this
    // dealer, so go-live can proceed without a double-bill risk.
    if (j.reason === "no-recurring-profile") {
      return { status: "none", detail: "no individual FreshBooks recurring profile on file (RECURE_ID absent in Aurora) — nothing to pause" };
    }
    if (j.reason === "dealer-not-in-aurora") {
      return { status: "none", detail: "dealer not found in Aurora dealer_dim — no legacy recurring profile to pause" };
    }
    // Failure — cutover deferred (da-billing stays in Setup), NEVER a token refresh.
    const why = j.reason?.startsWith("auth") ? `FreshBooks bearer ${j.reason.replace("auth-", "")} — legacy 4.0 refreshes it on its own schedule; retry via Resend or pause manually`
      : j.error ?? j.reason ?? "unknown error";
    return { status: "failed", detail: why };
  } catch (e) {
    const msg = e instanceof Error && e.name === "AbortError" ? "ETL box timed out" : e instanceof Error ? e.message : String(e);
    return { status: "failed", detail: `ETL box unreachable: ${msg}` };
  }
}

/** Non-mutating go-live pre-flight: is 5.0 billing actually ready to take
 *  over? Run BEFORE the FreshBooks pause so a dealer whose da-billing isn't
 *  staged never gets its 4.0 billing touched. */
async function preflightDaBilling(
  dealer: CutoverDealer,
): Promise<{ ok: boolean; detail: string; alreadyLive: boolean }> {
  if (!billingConfigured()) return { ok: false, detail: "billing API not configured", alreadyLive: false };
  const customerId = dealer.billing_customer_id;
  if (!customerId) return { ok: false, detail: "no da-billing customer linked", alreadyLive: false };
  try {
    const [customer, tmpl] = await Promise.all([getCustomer(customerId), getTemplate(customerId)]);
    if (!tmpl) return { ok: false, detail: `customer ${customerId} has no recurring template staged`, alreadyLive: false };
    const alreadyLive = tmpl.active === true && customer?.billingState !== "setup";
    return { ok: true, detail: "ready", alreadyLive };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e), alreadyLive: false };
  }
}

/**
 * Run the invite-time billing cutover for one SELF-BILLED dealer (the caller
 * has already checked scope + billing_verified). Never throws.
 * Ordering (see the banner at the top of this file): pre-flight da-billing →
 * pause FreshBooks → go live. A failed pause DEFERS go-live (Setup Mode kept,
 * no double-billing); a failed pre-flight leaves FreshBooks untouched (never
 * billing nowhere). The caller retries the whole cutover on Resend while
 * dealers.billing_cutover_at is still null.
 */
export async function runInviteBillingCutover(
  admin: SupabaseClient,
  dealer: CutoverDealer,
  performedBy?: string,
): Promise<BillingCutoverResult> {
  const nowIso = new Date().toISOString();

  // 1 — pre-flight (non-mutating). Not ready to go live → don't touch 4.0.
  const pre = await preflightDaBilling(dealer);
  if (!pre.ok) {
    const billing = { ok: false, detail: pre.detail };
    const freshbooks = { ok: false, detail: "skipped — da-billing is not ready to go live (4.0 billing left running so the dealer is never billing nowhere)" };
    return finishCutover(admin, dealer, performedBy, billing, freshbooks, false);
  }

  // 2 — pause FreshBooks FIRST.
  const pause = await pauseFreshBooks(admin, dealer, nowIso);
  if (pause.status === "failed") {
    // Deferred: da-billing stays in Setup Mode — the dealer keeps billing on
    // 4.0 only. The cutover re-runs on the next Resend (billing_cutover_at is
    // still null), or the operator pauses FB manually and hits Resend.
    const billing = pre.alreadyLive
      ? { ok: false, detail: "⚠️ da-billing is ALREADY LIVE (activated earlier) and the FreshBooks pause failed — dealer may be DOUBLE-BILLED; pause the FreshBooks profile manually ASAP" }
      : { ok: false, detail: "deferred — FreshBooks pause failed, da-billing left in Setup Mode (no double-billing); fix the pause then hit Resend to retry the cutover" };
    return finishCutover(admin, dealer, performedBy, billing, { ok: false, detail: pause.detail }, false);
  }

  // 3 — go live (pause confirmed, or nothing to pause).
  const billing = await goLiveDaBilling(admin, dealer, nowIso);
  let freshbooks: { ok: boolean; detail: string } = { ok: true, detail: pause.detail };
  let critical = false;
  if (!billing.ok && pause.status === "paused") {
    // Billing NOWHERE: FB is paused but 5.0 didn't go live. Pre-flight makes
    // this rare (transient da-billing failure). No auto-resume — re-enabling a
    // FB profile re-anchors its schedule to today (surprise-invoice risk);
    // recovery is completing go-live in da-billing (or Return to Setup +
    // resume the profile manually).
    freshbooks = { ok: false, detail: `${pause.detail} — ⚠️ CRITICAL: da-billing go-live FAILED AFTER the pause; the dealer is currently billing NOWHERE. Open the customer in da-billing and Go Live (or Return to Setup and resume FreshBooks profile).` };
    critical = true;
  }
  return finishCutover(admin, dealer, performedBy, billing, freshbooks, critical);
}

/** Shared tail: migration_log row + support alert when anything needs a human. */
async function finishCutover(
  admin: SupabaseClient,
  dealer: CutoverDealer,
  performedBy: string | undefined,
  billing: { ok: boolean; detail: string },
  freshbooks: { ok: boolean; detail: string },
  critical: boolean,
): Promise<BillingCutoverResult> {

  // Tracked outcome: migration_log row + alert when anything needs a human.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fireWrite((admin as any).from("migration_log").insert({
    dealer_id: dealer.id,
    event: "billing_cutover",
    performed_by: performedBy ?? null,
    billing_customer_id: dealer.billing_customer_id,
    notes: `invite-time cutover — da-billing: ${billing.ok ? "✓" : "✗"} ${billing.detail}; FreshBooks: ${freshbooks.ok ? "✓" : "✗"} ${freshbooks.detail}`,
  }), "migration_log billing_cutover");

  if (!billing.ok || !freshbooks.ok) {
    void supportAlert(
      `${critical ? "🚨 CRITICAL — dealer billing NOWHERE" : "⚠️ Invite billing cutover needs attention"} — ${dealer.name}`,
      `<p><strong>${dealer.name}</strong> (${dealer.dealer_id}) was sent a migration invite. The automatic billing cutover did not fully complete:</p>
       <ul>
         <li>da-billing go-live: <strong>${billing.ok ? "✓ " : "✗ "}</strong>${billing.detail}</li>
         <li>FreshBooks recurring pause: <strong>${freshbooks.ok ? "✓ " : "✗ "}</strong>${freshbooks.detail}</li>
       </ul>
       <p>${critical
         ? "<strong>Operator action (URGENT):</strong> FreshBooks is paused but da-billing is NOT live — the dealer is billing nowhere. Open the customer in da-billing and Go Live, or Return to Setup and resume the FreshBooks profile."
         : "<strong>Operator action:</strong> da-billing was left in Setup Mode — the dealer is still billing normally on 4.0 (no double-bill). Fix the FreshBooks pause (or pause the profile manually — never dry-run-then-live), then hit Resend on the dealer to retry the cutover."}
       The invite itself was sent successfully.</p>`,
    );
  }

  console.log(`[billing-cutover] dealer=${dealer.dealer_id} (${dealer.name}) billing=${billing.ok ? "ok" : "FAIL"} (${billing.detail}) freshbooks=${freshbooks.ok ? "ok" : "PENDING"} (${freshbooks.detail})`);
  return { billing: billing.detail, billingOk: billing.ok, freshbooks: freshbooks.detail, freshbooksOk: freshbooks.ok };
}
