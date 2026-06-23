import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { billingConfigured, setTemplateStatus, setBillingState } from "@/lib/billing";

export const dynamic = "force-dynamic";

/**
 * POST /api/migration/activate-billing — super_admin only.
 * Activates the da-billing recurring template for a dealer whose
 * migration_status = 'migrated' but whose billing is still paused
 * (MIGRATION_AUTO_ACTIVATE was OFF when they self-migrated).
 *
 * Body: { dealer_id: string }
 *
 * Resolves billing customer:
 *   - subscription_billed_to = 'group' → use the group's billing_customer_id
 *   - otherwise → use dealer.billing_customer_id
 *
 * Inserts a migration_log row on success. If the table doesn't exist yet
 * (migration 111 not applied) the insert error is swallowed so the billing
 * activation itself is not blocked.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  let body: { dealer_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.dealer_id) {
    return NextResponse.json({ error: "dealer_id required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // Look up the dealer — must exist and be in 'migrated' state.
  const { data: dealer } = await admin
    .from("dealers")
    .select("id, name, group_id, subscription_billed_to, billing_customer_id, migration_status")
    .eq("id", body.dealer_id)
    .maybeSingle<{
      id: string;
      name: string;
      group_id: string | null;
      subscription_billed_to: string | null;
      billing_customer_id: string | null;
      migration_status: string | null;
    }>();

  if (!dealer) {
    return NextResponse.json({ error: "Dealer not found" }, { status: 404 });
  }
  if (dealer.migration_status !== "migrated") {
    return NextResponse.json(
      { error: `Dealer is not migrated (migration_status = '${dealer.migration_status}')` },
      { status: 400 },
    );
  }

  // Resolve the billing customer id.
  let customerId = dealer.billing_customer_id;
  if (dealer.subscription_billed_to === "group" && dealer.group_id) {
    const { data: grp } = await admin
      .from("groups")
      .select("billing_customer_id")
      .eq("id", dealer.group_id)
      .maybeSingle<{ billing_customer_id: string | null }>();
    customerId = grp?.billing_customer_id ?? null;
  }

  if (!customerId) {
    return NextResponse.json({ error: "No billing customer linked" }, { status: 400 });
  }

  if (!billingConfigured()) {
    return NextResponse.json({ error: "Billing API not configured on this server" }, { status: 503 });
  }

  // Activate the template (active: true, no nextInvoiceDate — billing picks up on the next daily cron).
  try {
    await setTemplateStatus(customerId, true);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Billing activation failed: ${msg}` }, { status: 502 });
  }

  // Also take the customer OUT of setup mode so invoices actually email (the
  // template is now live). Best-effort: the template is already activated above,
  // so a failure here is surfaced as a warning rather than failing the whole
  // action. (billingState absent/'active' already emails; this matters when the
  // dealer was explicitly in 'setup'.)
  let billingStateWarning: string | undefined;
  try {
    await setBillingState(customerId, "active");
  } catch (e) {
    billingStateWarning = e instanceof Error ? e.message : String(e);
    console.warn("[activate-billing] template activated but set-billing-state failed:", billingStateWarning);
  }

  // Insert into migration_log. If the table doesn't exist yet (migration 111 not
  // applied) the error is caught and logged without failing the request.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: logErr } = await (admin as any).from("migration_log").insert({
      dealer_id: dealer.id,
      event: "billing_activated",
      performed_by: claims.sub,
      billing_customer_id: customerId,
    });
    if (logErr) {
      // "relation does not exist" = migration 111 not yet applied — safe to ignore.
      if (!logErr.message?.includes("does not exist")) {
        console.warn("[activate-billing] migration_log insert failed:", logErr.message);
      } else {
        console.warn("[activate-billing] migration_log table not yet created — run migration 111");
      }
    }
  } catch (logEx) {
    console.warn("[activate-billing] migration_log insert threw:", logEx);
  }

  return NextResponse.json({
    ok: true,
    customerId,
    dealer: dealer.name,
    billingState: billingStateWarning ? "setup?" : "active",
    ...(billingStateWarning ? { billingStateWarning } : {}),
  });
}
