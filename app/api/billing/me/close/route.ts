// POST /api/billing/me/close — dealer self-close (downgrade to Free).
//
// Spec: docs/dealer-self-close-account.md. Reuses the Downgraded +
// 60-day archive plumbing already shipped (b822b86). Flow:
//   1. Auth: dealer_admin → own dealer; super_admin → any (ghost or
//      ?dealer_id=); group_admin → the member dealer they're switched into
//      (active dealer, group-verified). dealer_user denied.
//   2. Re-check $0 balance server-side via the same listInvoices the
//      BillingTab reads. Pending + overdue invoices → 409 with the
//      outstanding amount + count so the UI's pay-first message stays
//      truthful.
//   3. da-billing: deleteTemplate(customerKey) — stops the recurring
//      invoice cron immediately. Do NOT archiveCustomer here; that's
//      the +60-day cron's job (archive-downgraded).
//   4. Platform: dealers.account_type='Free', downgraded_at=now().
//      active stays true so the dealer keeps log-in access during the
//      grace window.
//   5. Reason row: account_closures insert (soft, optional).
//   6. HubSpot: fireDealerReliable() pushes lifecyclestage=Downgraded
//      via the retry+alert path (subscription/lifecycle workflows
//      depend on it landing).
//
// Re-opens (re-subscribing within 60 days) happen via the existing
// /api/billing/me/subscription PATCH path — that one creates a new
// template and pushes the lifecycle back to Customer. No new code.

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { billingConfigured, deleteTemplate, listInvoices } from "@/lib/billing";
import { fireDealerReliable } from "@/lib/sync-hubspot";
import { sendMandrillEmail } from "@/lib/mandrill";

const SUPPORT_EMAIL = process.env.SUPPORT_NOTIFICATION_EMAIL ?? "support@dealeraddendums.com";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  // dealer_admin closes their own account; super_admin can close any (typically
  // while ghosting); group_admin can close a member dealer they're switched into
  // (active dealer, group-verified below). dealer_user is read-only here.
  if (claims.role !== "dealer_admin" && claims.role !== "super_admin" && claims.role !== "group_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!billingConfigured()) {
    return NextResponse.json({ error: "Billing API not configured" }, { status: 500 });
  }

  let body: { reason?: string; detail?: string };
  try { body = (await req.json()) as typeof body; }
  catch { body = {}; }
  const reason = body.reason?.trim() || null;
  const detail = body.detail?.trim() || null;

  // Resolve target dealer.
  const admin = createAdminSupabaseClient();
  let dealerTextId: string | null = null;
  if (claims.role === "dealer_admin") {
    dealerTextId = claims.dealer_id ?? null;
  } else if (claims.role === "group_admin") {
    // Only the active (switched-into) member dealer; group-verified after fetch.
    dealerTextId = claims.dealer_id ?? null;
  } else {
    // super_admin: ghost-mode dealer_id (claims.dealer_id) OR ?dealer_id= override
    const param = req.nextUrl.searchParams.get("dealer_id");
    dealerTextId = param ?? claims.dealer_id ?? null;
  }
  if (!dealerTextId) {
    return NextResponse.json({ error: "No dealer assigned" }, { status: 403 });
  }

  const { data: dealer } = await admin
    .from("dealers")
    .select("id, dealer_id, name, billing_customer_id, internal_id, account_type, group_id")
    .eq("dealer_id", dealerTextId)
    .maybeSingle<{
      id: string;
      dealer_id: string;
      name: string;
      billing_customer_id: string | null;
      internal_id: string | null;
      account_type: string | null;
      group_id: string | null;
    }>();
  if (!dealer) {
    return NextResponse.json({ error: "Dealer not found" }, { status: 404 });
  }

  // group_admin may only close a dealer in their own group (the active dealer).
  if (claims.role === "group_admin" && dealer.group_id !== claims.group_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ── $0 balance gate ─────────────────────────────────────────────────────
  // Re-fetch from da-billing — don't trust the client's `outstandingAmount`.
  // Same call the BillingTab uses, so the numbers match exactly.
  const customerKey = dealer.billing_customer_id ?? dealer.internal_id;
  if (!customerKey) {
    // No billing customer = no recurring template to cancel. Still allowed —
    // flip the account_type so the platform's print gate + HubSpot lifecycle
    // catch up.
    return await finalizeClose(admin, dealer, reason, detail, claims.sub);
  }

  let outstandingAmount = 0;
  let outstandingCount = 0;
  try {
    const result = await listInvoices(customerKey);
    outstandingAmount = result.outstandingAmount;
    outstandingCount = result.invoices.filter(i => i.status === "pending" || i.status === "overdue").length;
  } catch (err) {
    return NextResponse.json(
      { error: `Could not verify your balance with billing — try again. (${err instanceof Error ? err.message : String(err)})` },
      { status: 502 },
    );
  }

  if (outstandingAmount > 0) {
    return NextResponse.json({
      error: "balance_due",
      message: `Settle your balance ($${outstandingAmount.toFixed(2)}, ${outstandingCount} invoice${outstandingCount === 1 ? "" : "s"}) before closing.`,
      outstandingAmount,
      outstandingCount,
    }, { status: 409 });
  }

  // ── Cancel recurring at da-billing ──────────────────────────────────────
  // deleteTemplate is idempotent: a 404 (already gone) is treated as success.
  try {
    await deleteTemplate(customerKey);
  } catch (err) {
    return NextResponse.json(
      { error: `Could not cancel recurring billing — try again. (${err instanceof Error ? err.message : String(err)})` },
      { status: 502 },
    );
  }

  return await finalizeClose(admin, dealer, reason, detail, claims.sub);
}

async function finalizeClose(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  dealer: { id: string; dealer_id: string; name: string; account_type: string | null },
  reason: string | null,
  detail: string | null,
  closedBy: string,
): Promise<NextResponse> {
  // ── Platform: Downgraded, still active ────────────────────────────────────
  // active stays true so the dealer can log back in (view-only) during the
  // 60-day grace window. The archive-downgraded cron handles the final
  // active=false flip if they don't re-subscribe.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: uErr } = await (admin as any)
    .from("dealers")
    .update({
      account_type: "Free",
      downgraded_at: new Date().toISOString(),
    })
    .eq("id", dealer.id);
  if (uErr) {
    return NextResponse.json(
      { error: `Dealer update failed: ${uErr.message}` },
      { status: 500 },
    );
  }

  // ── account_closures row ────────────────────────────────────────────────
  // Soft reason — both fields are optional. Failure here doesn't block the
  // close (the cancellation already happened); log + continue.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const closureRes = await (admin as any).from("account_closures").insert({
    dealer_id: dealer.id,
    reason,
    detail,
    closed_by: closedBy,
  });
  if (closureRes.error) {
    console.error("[billing/close] account_closures insert failed:", closureRes.error.message);
  }

  // ── HubSpot lifecycle update (reliable path) ────────────────────────────
  // Reliable variant retries + Mandrill-alerts on terminal failure — the
  // workflow trigger for "Account Downgraded" depends on this landing.
  fireDealerReliable(dealer.id, "dealer self-close (Free downgrade)");

  // Staff notification — fire-and-forget.
  sendMandrillEmail({
    subject: `Account Downgraded to Free: ${dealer.name}`,
    html: `<p><strong>Dealer has downgraded to Free (self-close).</strong></p>
<table style="font-family:sans-serif;font-size:14px;border-collapse:collapse">
  <tr><td style="padding:4px 12px 4px 0;color:#666">Dealership</td><td><strong>${dealer.name}</strong></td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666">Dealer ID</td><td>${dealer.dealer_id}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666">Was</td><td>${dealer.account_type ?? "Unknown"}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666">Closed</td><td>${new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} PT</td></tr>
  ${reason ? `<tr><td style="padding:4px 12px 4px 0;color:#666">Reason</td><td>${reason}${detail ? ` — ${detail}` : ""}</td></tr>` : ""}
</table>`,
    from_email: "noreply@dealeraddendums.com",
    from_name: "DA Platform",
    to: [{ email: SUPPORT_EMAIL, name: "DA Support" }],
  }).catch(err => console.error("[notify-support] paid→free:", err instanceof Error ? err.message : err));

  return NextResponse.json({
    ok: true,
    dealer_id: dealer.dealer_id,
    new_account_type: "Free",
  });
}
