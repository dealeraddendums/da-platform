// Invite-time billing cutover (2026-08-17) — fired after a SELF-BILLED dealer's
// FIRST migration invite is successfully sent:
//
//   2a. da-billing go-live: take the dealer's own customer out of Setup Mode +
//       activate the recurring template, preserving a FUTURE nextInvoiceDate
//       (no catch-up invoice). Idempotent — an already-live customer is a no-op.
//       Success stamps dealers.billing_cutover_at (if not already stamped).
//   2b. FreshBooks recurring pause: proxied to the ETL box's key-gated
//       POST /freshbooks/recurring-pause (the box owns Aurora + the FB bearer).
//       WRITE-BUT-NEVER-REFRESH: an expired bearer or any failure falls back to
//       the existing manual freshbooksStopPending path + a support@ alert —
//       never a token refresh. A confirmed pause (or a profile that no longer
//       exists in FreshBooks) stamps dealers.freshbooks_stopped_at.
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

/** 2b — FreshBooks recurring pause via the ETL box (write-but-never-refresh). */
async function pauseFreshBooks(
  admin: SupabaseClient,
  dealer: CutoverDealer,
  nowIso: string,
): Promise<{ ok: boolean; detail: string }> {
  const etlUrl = process.env.ETL_SYNC_URL;
  const etlKey = process.env.ETL_SYNC_API_KEY;
  if (!etlUrl || !etlKey) return { ok: false, detail: "ETL_SYNC_URL / ETL_SYNC_API_KEY not configured" };
  if (!dealer.inventory_dealer_id) return { ok: false, detail: "no inventory_dealer_id (cannot resolve Aurora RECURE_ID)" };
  const base = etlUrl.replace(/\/sync\/?$/, "");
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 45_000);
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
    if (!res.ok || !j) return { ok: false, detail: `ETL box HTTP ${res.status}` };
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
      return { ok: true, detail: what };
    }
    // Failure — manual fallback (freshbooksStopPending), NEVER a token refresh.
    const why = j.reason === "no-recurring-profile" ? "no RECURE_ID on file in Aurora — verify manually"
      : j.reason?.startsWith("auth") ? `FreshBooks bearer ${j.reason.replace("auth-", "")} — legacy 4.0 refreshes it on its own schedule; pause manually or retry later`
      : j.reason === "dealer-not-in-aurora" ? "dealer not found in Aurora dealer_dim"
      : j.error ?? j.reason ?? "unknown error";
    return { ok: false, detail: why };
  } catch (e) {
    const msg = e instanceof Error && e.name === "AbortError" ? "ETL box timed out" : e instanceof Error ? e.message : String(e);
    return { ok: false, detail: `ETL box unreachable: ${msg}` };
  }
}

/**
 * Run the invite-time billing cutover for one SELF-BILLED dealer (the caller
 * has already checked scope + billing_verified + first-invite). Never throws.
 * Ordering: 2a first — if 5.0 billing could not go live, 4.0 FreshBooks is NOT
 * paused (a dealer must never end up billing nowhere); the FB stop stays on the
 * manual freshbooksStopPending path in that case.
 */
export async function runInviteBillingCutover(
  admin: SupabaseClient,
  dealer: CutoverDealer,
  performedBy?: string,
): Promise<BillingCutoverResult> {
  const nowIso = new Date().toISOString();
  const billing = await goLiveDaBilling(admin, dealer, nowIso);

  let freshbooks: { ok: boolean; detail: string };
  if (billing.ok) {
    freshbooks = await pauseFreshBooks(admin, dealer, nowIso);
  } else {
    freshbooks = { ok: false, detail: "skipped — da-billing go-live did not succeed (4.0 billing left running so the dealer is never billing nowhere)" };
  }

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
      `⚠️ Invite billing cutover needs attention — ${dealer.name}`,
      `<p><strong>${dealer.name}</strong> (${dealer.dealer_id}) was sent a migration invite. The automatic billing cutover did not fully complete:</p>
       <ul>
         <li>da-billing go-live: <strong>${billing.ok ? "✓ " : "✗ "}</strong>${billing.detail}</li>
         <li>FreshBooks recurring pause: <strong>${freshbooks.ok ? "✓ " : "✗ "}</strong>${freshbooks.detail}</li>
       </ul>
       <p>${freshbooks.ok ? "" : "<strong>Operator action:</strong> stop the FreshBooks recurring profile manually (never dry-run-then-live). "}The invite itself was sent successfully.</p>`,
    );
  }

  console.log(`[billing-cutover] dealer=${dealer.dealer_id} (${dealer.name}) billing=${billing.ok ? "ok" : "FAIL"} (${billing.detail}) freshbooks=${freshbooks.ok ? "ok" : "PENDING"} (${freshbooks.detail})`);
  return { billing: billing.detail, billingOk: billing.ok, freshbooks: freshbooks.detail, freshbooksOk: freshbooks.ok };
}
