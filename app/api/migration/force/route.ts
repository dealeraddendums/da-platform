import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { migrateDealerRecord } from "@/lib/migrate-dealer";
import { setLegacyMigratedFlag } from "@/lib/legacy-lockout";
import { loadReadinessRows } from "@/lib/migration-readiness-data";
import { loadForceFlags, computeForceVerdict, resolveRecipients } from "@/lib/force-migration";
import { checkDeliverability, type DeliverabilityState } from "@/lib/mandrill";
import { billingConfigured, getTemplate, activateTemplate, setBillingState } from "@/lib/billing";
import { futureNextInvoice } from "@/lib/migrate-dealer";
import { sendMandrillEmail } from "@/lib/mandrill";
import { buildForcedMigrationEmail } from "@/lib/invite-email";

export const dynamic = "force-dynamic";

// Team alert (same shape as /api/migrate/confirm — no shared helper exists).
const alert = (subject: string, html: string) =>
  sendMandrillEmail({ subject, from_email: "noreply@dealeraddendums.com", from_name: "DealerAddendums", to: [{ email: "support@dealeraddendums.com", name: "DA Support" }], html })
    .catch((e) => console.error("[force] alert email failed:", e instanceof Error ? e.message : e));

/**
 * POST /api/migration/force — super_admin only. Body: { dealerId }
 *
 * Force-migrate ONE dealer onto 5.0, as a deliberate manual act by a team
 * member. Spec: suite root force-migration-spec.md.
 *
 * ── Why the order is probe → 5.0 → 4.0 ───────────────────────────────────────
 * The two platform flips must be all-or-nothing. The overwhelmingly likely
 * failure is a dealer whose legacy DEALER_ID 4.0 doesn't recognise (155 of our
 * 4.0-origin dealers don't resolve), which returns 404. So we PROBE first by
 * asking 4.0 to set migrated_to_v5 = FALSE: for a dealer that hasn't migrated
 * that is a genuine no-op, but it proves the id maps before we write anything
 * on the 5.0 side. Only then do we flip 5.0 (which has side effects — Box,
 * HubSpot, the conversion webhook) and finally 4.0. If that last call fails we
 * restore the 5.0 row to exactly its prior values and push 4.0 back to false,
 * so the dealer is never left half-migrated.
 *
 * Billing auto-activates (Allan, 2026-09-27) — the queue already gated on
 * billing being verified, and a human is reviewing each one. A billing failure
 * is reported loudly but does NOT roll back the migration: both platforms are
 * already consistent at that point, and /api/migration/activate-billing exists
 * to finish the job. Rolling a dealer back off 5.0 over a billing hiccup would
 * be the more disruptive outcome.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  let body: { dealerId?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body.dealerId) return NextResponse.json({ error: "dealerId required" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data: dealer } = await admin
    .from("dealers")
    .select("id, dealer_id, name, group_id, subscription_billed_to, billing_customer_id, account_type, migration_status, converted_at, downgraded_at, billing_cutover_at, inventory_provider, inventory_provider_is_dms, box_folder_id, freshbooks_stopped_at, inventory_dealer_id, primary_contact, primary_contact_email")
    .eq("id", body.dealerId)
    .maybeSingle<DealerRow>();
  if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });

  // ── 1. Re-check the verdict AT CLICK TIME ─────────────────────────────────
  // The queue was rendered from a snapshot; email deliverability and readiness
  // can both have changed since. The button and the server use the same gate.
  const verdictCheck = await recheckVerdict(dealer.id, dealer.dealer_id);
  if (verdictCheck.verdict !== "safe") {
    return NextResponse.json({
      error: `Not safe to force: ${verdictCheck.reasons.join("; ")}`,
      verdict: verdictCheck.verdict,
      reasons: verdictCheck.reasons,
    }, { status: 409 });
  }

  // ── 2. PROBE 4.0 (no-op write) to prove the DEALER_ID maps ────────────────
  const probe = await setLegacyMigratedFlag(dealer.dealer_id, false);
  if (!probe.ok) {
    return NextResponse.json({
      error: probe.dealerNotFound
        ? `4.0 does not recognise DEALER_ID "${dealer.dealer_id}" — nothing was changed. Fix the legacy id mapping before forcing.`
        : `Could not reach the 4.0 flag endpoint — nothing was changed. ${probe.detail}`,
      stage: "probe",
      detail: probe.detail,
    }, { status: 502 });
  }

  // ── 3. Capture prior state so the 5.0 flip is exactly reversible ──────────
  const prior = {
    migration_status: dealer.migration_status,
    account_type: dealer.account_type,
    converted_at: dealer.converted_at,
    downgraded_at: dealer.downgraded_at,
    billing_cutover_at: dealer.billing_cutover_at,
  };
  const nowIso = new Date().toISOString();

  // ── 4. Flip 5.0 (canonical migrate write set, minus the async 4.0 call) ───
  const res = await migrateDealerRecord(admin, dealer, {
    nowIso,
    hubspotContext: "force-migration",
    skipLegacyLockout: true,
    extraPatch: { forced_at: nowIso, forced_by: claims.sub },
  });
  if (!res.ok) {
    return NextResponse.json({ error: `5.0 migration write failed: ${res.error}`, stage: "5.0" }, { status: 500 });
  }

  // ── 5. Flip 4.0 — the point of no return. Failure ⇒ full revert. ──────────
  const flag = await setLegacyMigratedFlag(dealer.dealer_id, true);
  if (!flag.ok) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any).from("dealers").update({
      ...prior,
      forced_at: null,
      forced_by: null,
    }).eq("id", dealer.id);
    // Belt and braces: make sure 4.0 is definitely back to "not migrated".
    const undo = await setLegacyMigratedFlag(dealer.dealer_id, false);
    console.error(`[force] 4.0 flip FAILED for ${dealer.dealer_id} — 5.0 reverted. ${flag.detail}`);
    return NextResponse.json({
      error: `4.0 did not accept the migrated flag — the 5.0 migration was rolled back, nothing is half-done. ${flag.detail}`,
      stage: "4.0",
      reverted: true,
      fourZeroRestored: undo.ok,
    }, { status: 502 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any).from("dealers")
    .update({ legacy_lockout_at: nowIso, legacy_lockout_pending: false })
    .eq("id", dealer.id);

  // ── 6. Billing: AUTO-ACTIVATE (never rolls the migration back) ────────────
  const billing = await activateBilling(admin, dealer);

  // ── 7. FreshBooks recurring-stop (operator task, same as self-migration) ──
  if (!dealer.freshbooks_stopped_at) {
    void alert(
      `⚠️ Queue FreshBooks recurring-stop — ${dealer.name}`,
      `<p><strong>${dealer.name}</strong> (${dealer.dealer_id}) was <strong>force-migrated</strong> to 5.0. <strong>Operator action:</strong> stop their FreshBooks recurring profile (manually — do not dry-run-then-live).</p>`,
    );
  }

  // ── 8. Tell the dealer how to get in ──────────────────────────────────────
  const emailed = await notifyDealer(dealer, verdictCheck.recipients);

  // ── 9. Audit ──────────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: logErr } = await (admin as any).from("migration_log").insert({
    dealer_id: dealer.id,
    event: "force_migrated",
    performed_by: claims.sub,
    billing_customer_id: billing.customerId,
    notes: JSON.stringify({ prior, plan: res.plan, billing: billing.state, billingDetail: billing.detail, emailed, legacyDealerId: dealer.dealer_id }),
  });
  if (logErr) console.warn("[force] migration_log insert failed:", logErr.message);

  console.log(`[force] FORCE-MIGRATED dealer=${dealer.dealer_id} (${dealer.name}) by=${claims.sub} plan=${res.plan} billing=${billing.state} emailed=${emailed.sent}`);
  void alert(
    `✅ Force-migrated — ${dealer.name}`,
    `<p><strong>${dealer.name}</strong> (${dealer.dealer_id}) was force-migrated to 5.0.<br>Plan: ${res.plan}<br>4.0 migrated_to_v5: <strong>Yes</strong><br>Billing: <strong>${billing.state}</strong> — ${billing.detail}<br>Notified: ${emailed.sent ? emailed.to.join(", ") : `NOT SENT (${emailed.detail})`}</p>`,
  );

  return NextResponse.json({
    ok: true,
    dealer: dealer.name,
    plan: res.plan,
    fourZero: "migrated_to_v5=Yes",
    billing: billing.state,
    billingDetail: billing.detail,
    emailed,
  });
}

interface DealerRow {
  id: string; dealer_id: string; name: string; group_id: string | null;
  subscription_billed_to: string | null; billing_customer_id: string | null;
  account_type: string | null; migration_status: string | null;
  converted_at: string | null; downgraded_at: string | null; billing_cutover_at: string | null;
  inventory_provider: string | null; inventory_provider_is_dms: boolean | null;
  box_folder_id: string | null; freshbooks_stopped_at: string | null;
  inventory_dealer_id: string | null; primary_contact: string | null; primary_contact_email: string | null;
}

/** Same gate the queue renders, recomputed for one dealer at click time. */
async function recheckVerdict(dealerUuid: string, legacyDealerId: string): Promise<{ verdict: string; reasons: string[]; recipients: string[] }> {
  const { rows } = await loadReadinessRows({ dealerIds: [dealerUuid] });
  const r = rows.find((x) => x.id === dealerUuid);
  if (!r) return { verdict: "excluded", reasons: ["dealer is not in the readiness set (test/demo account?)"], recipients: [] };
  const flags = await loadForceFlags([dealerUuid]);
  const f = flags.get(dealerUuid);

  const recipients = resolveRecipients(r.inviteRecipients, f?.primary_contact_email);

  let state: DeliverabilityState = "unknown";
  if (recipients.length) {
    const checks = await Promise.all(recipients.map((e) => checkDeliverability(e)));
    if (checks.some((c) => c.state === "ok")) state = "ok";
    else if (checks.every((c) => c.state === "bounced")) state = "bounced";
  }

  const d = computeForceVerdict({
    synced: r.synced,
    billingStaged: r.billingStaged,
    billingApplicable: r.billingApplicable,
    templateConfirmed: r.templateConfirmed,
    eligible: r.eligible,
    eligibleReason: r.eligibleReason,
    finalNoticeAt: f?.final_notice_at ?? null,
    hold: !!f?.force_hold,
    deliverability: state,
    legacyDealerId,
    hasRecipient: recipients.length > 0,
  });
  return { verdict: d.verdict, reasons: d.reasons, recipients };
}

/** da-billing go-Live for the responsible payer. Never throws. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function activateBilling(admin: any, dealer: DealerRow): Promise<{ state: string; detail: string; customerId: string | null }> {
  let customerId = dealer.billing_customer_id;
  if (dealer.subscription_billed_to === "group" && dealer.group_id) {
    const { data: g } = await admin.from("groups").select("billing_customer_id").eq("id", dealer.group_id).maybeSingle();
    customerId = g?.billing_customer_id ?? null;
  }
  if (!billingConfigured()) return { state: "skipped", detail: "billing API not configured", customerId };
  if (!customerId) return { state: "no-customer", detail: dealer.subscription_billed_to === "group" ? "group has no billing customer" : "dealer has no billing customer", customerId: null };

  try {
    const tmpl = await getTemplate(customerId).catch(() => null);
    if (tmpl?.active === true) {
      return { state: "already-live", detail: `template already live — nextInvoiceDate=${tmpl?.nextInvoiceDate ?? "unchanged"}`, customerId };
    }
    const next = futureNextInvoice(tmpl?.nextInvoiceDate ?? undefined, Date.now());
    await activateTemplate(customerId, next);
    let detail = `active=true, nextInvoiceDate=${next}`;
    try { await setBillingState(customerId, "active"); }
    catch (e) { detail += ` (set-billing-state failed: ${e instanceof Error ? e.message : String(e)})`; }
    return { state: "activated", detail, customerId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[force] billing activation failed:", msg);
    return { state: "error", detail: msg, customerId };
  }
}

/** "You're on 5.0 — here's how to sign in." Never throws. */
async function notifyDealer(dealer: DealerRow, recipients: string[]): Promise<{ sent: boolean; to: string[]; detail?: string }> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.dealeraddendums.com";
  const to = recipients.length ? recipients : (dealer.primary_contact_email ? [dealer.primary_contact_email] : []);
  if (!to.length) return { sent: false, to: [], detail: "no recipient" };
  const firstName = (dealer.primary_contact ?? "").trim().split(/\s+/)[0] || "there";
  const sentTo: string[] = [];
  const failures: string[] = [];
  for (const email of to) {
    try {
      await sendMandrillEmail({
        subject: `${dealer.name} has moved to DealerAddendums Platform 5.0`,
        from_email: "noreply@dealeraddendums.com",
        from_name: "DealerAddendums",
        to: [{ email }],
        html: buildForcedMigrationEmail({ firstName, orgName: dealer.name, loginUrl: `${appUrl}/login` }),
      });
      sentTo.push(email);
    } catch (e) {
      failures.push(`${email}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { sent: sentTo.length > 0, to: sentTo, ...(failures.length ? { detail: failures.join("; ") } : {}) };
}
