import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { setLegacyMigratedFlag } from "@/lib/legacy-lockout";
import { billingConfigured, deactivateTemplate, setBillingState } from "@/lib/billing";

export const dynamic = "force-dynamic";

/**
 * POST /api/migration/unforce — super_admin only. Body: { dealerId }
 *
 * One-step revert of a wrongly-forced dealer. Forcing touches both money and
 * access, so the undo has to be as easy as the do. Reverses, in the order that
 * restores the dealer's ACCESS first:
 *   1. 4.0 migrated_to_v5 = false  → their 4.0 login works again immediately
 *   2. 5.0 migration_status back to 'invited' (+ clears the force stamps)
 *   3. da-billing template paused and the customer returned to setup mode, so
 *      no invoice is issued off a migration that has been taken back
 *   4. migration_log audit row
 *
 * Access is restored before billing because a dealer locked out of both
 * platforms is the failure this whole feature exists to avoid; an extra minute
 * with a live billing template is comparatively harmless and step 3 is
 * best-effort with a loud warning if it fails.
 *
 * Deliberately does NOT undo Box folders, HubSpot lifecycle or the conversion
 * webhook — those are additive and harmless, and un-creating them would lose
 * real data. account_type is restored from the audit trail when available.
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
    .select("id, dealer_id, name, group_id, subscription_billed_to, billing_customer_id, migration_status")
    .eq("id", body.dealerId)
    .maybeSingle<{ id: string; dealer_id: string; name: string; group_id: string | null; subscription_billed_to: string | null; billing_customer_id: string | null; migration_status: string | null }>();
  if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });

  // Recover the pre-force values from the force audit row, so the revert puts
  // back exactly what was there rather than a guess.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: logRows } = await (admin as any)
    .from("migration_log")
    .select("notes, created_at")
    .eq("dealer_id", dealer.id)
    .eq("event", "force_migrated")
    .order("created_at", { ascending: false })
    .limit(1);
  let prior: Record<string, unknown> | null = null;
  try {
    const notes = (logRows ?? [])[0]?.notes;
    if (notes) prior = (JSON.parse(notes) as { prior?: Record<string, unknown> }).prior ?? null;
  } catch { /* notes not JSON — fall back to defaults below */ }

  // ── 1. Re-open 4.0 FIRST (restores the dealer's access) ───────────────────
  const flag = await setLegacyMigratedFlag(dealer.dealer_id, false);
  if (!flag.ok) {
    return NextResponse.json({
      error: `Could not clear the 4.0 migrated flag — nothing was changed, so the dealer is still consistently on 5.0. ${flag.detail}`,
      stage: "4.0",
    }, { status: 502 });
  }

  // ── 2. 5.0 back to invited ────────────────────────────────────────────────
  const patch: Record<string, unknown> = {
    migration_status: prior?.migration_status ?? "invited",
    account_type: prior?.account_type ?? null,
    converted_at: prior?.converted_at ?? null,
    downgraded_at: prior?.downgraded_at ?? null,
    billing_cutover_at: prior?.billing_cutover_at ?? null,
    forced_at: null,
    forced_by: null,
    legacy_lockout_at: null,
    legacy_lockout_pending: false,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: upErr } = await (admin as any).from("dealers").update(patch).eq("id", dealer.id);
  if (upErr) {
    // 4.0 is already re-opened; re-close it so the two sides stay consistent.
    await setLegacyMigratedFlag(dealer.dealer_id, true);
    return NextResponse.json({ error: `5.0 revert failed: ${upErr.message}`, stage: "5.0" }, { status: 500 });
  }

  // ── 3. Undo the billing go-Live (best-effort, loud on failure) ────────────
  let billing = "skipped";
  let billingDetail = "";
  let customerId = dealer.billing_customer_id;
  if (dealer.subscription_billed_to === "group" && dealer.group_id) {
    const { data: g } = await admin.from("groups").select("billing_customer_id").eq("id", dealer.group_id).maybeSingle<{ billing_customer_id: string | null }>();
    customerId = g?.billing_customer_id ?? null;
  }
  if (billingConfigured() && customerId) {
    try {
      await deactivateTemplate(customerId);
      billing = "paused";
      try { await setBillingState(customerId, "setup"); billingDetail = "template paused, customer back in setup mode"; }
      catch (e) { billingDetail = `template paused, but set-billing-state failed: ${e instanceof Error ? e.message : String(e)}`; }
    } catch (e) {
      billing = "error";
      billingDetail = e instanceof Error ? e.message : String(e);
      console.error("[unforce] billing revert failed:", billingDetail);
    }
  } else {
    billingDetail = customerId ? "billing API not configured" : "no billing customer linked";
  }

  // ── 4. Audit ──────────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: logErr } = await (admin as any).from("migration_log").insert({
    dealer_id: dealer.id,
    event: "force_reverted",
    performed_by: claims.sub,
    billing_customer_id: customerId,
    notes: JSON.stringify({ restored: patch, billing, billingDetail, priorFound: !!prior }),
  });
  if (logErr) console.warn("[unforce] migration_log insert failed:", logErr.message);

  console.log(`[unforce] REVERTED dealer=${dealer.dealer_id} (${dealer.name}) by=${claims.sub} billing=${billing}`);

  return NextResponse.json({
    ok: true,
    dealer: dealer.name,
    migration_status: patch.migration_status,
    fourZero: "migrated_to_v5=No",
    billing,
    billingDetail,
    priorStateRecovered: !!prior,
  });
}
