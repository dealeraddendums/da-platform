import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { sendMandrillEmail } from "@/lib/mandrill";
import { authorizeDealerAction } from "@/lib/dealer-authz";

// One-time free 25-label sample for Trial dealers. No billing — just stage the
// order for XPS pull and email Virginia. Enforced one-per-dealership server-side
// via dealers.trial_labels_claimed_at (claimed atomically, mirror of the
// sample_seeded_at pattern). See migration 115.

// Allowed label SKUs → human product name shown to Virginia / on the order.
const TRIAL_LABEL_PRODUCTS: Record<string, string> = {
  "8300-1": 'Regular Addendum Labels (4.25"×11")',
  "8300-3": 'Narrow Addendum Labels (3.125"×11")',
  "8300": "Full Sheet Labels (8.5\"×11\")",
};

const FREE_TRIAL_QTY = 25;

interface ShipTo {
  name: string;
  company?: string;
  address1: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string;
}

interface TrialLabelBody {
  dealerUuid: string;
  labelSku: string;
  shipTo: ShipTo;
}

function formatDateUS(date: Date): string {
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  // dealer_admin places it for their own dealership; super_admin covers
  // impersonation (ghost or session-switch into a dealer). All others 403.
  const ALLOWED_ROLES = new Set(["dealer_admin", "super_admin"]);
  if (!ALLOWED_ROLES.has(claims.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: TrialLabelBody;
  try {
    body = (await req.json()) as TrialLabelBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { dealerUuid, labelSku, shipTo } = body;
  if (!dealerUuid) {
    return NextResponse.json({ error: "Missing dealerUuid" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // 2. Fetch dealer.
  const { data: dealer } = await admin
    .from("dealers")
    .select("id, dealer_id, name, internal_id, account_type, trial_labels_claimed_at, primary_contact, primary_contact_email")
    .eq("id", dealerUuid)
    .maybeSingle<{
      id: string;
      dealer_id: string;
      name: string;
      internal_id: string | null;
      account_type: string | null;
      trial_labels_claimed_at: string | null;
      primary_contact: string | null;
      primary_contact_email: string | null;
    }>();

  if (!dealer) {
    return NextResponse.json({ error: "Dealer not found" }, { status: 404 });
  }

  // 3. Authorize the acting user against this dealer (own / impersonated).
  const authz = await authorizeDealerAction(claims, dealer.dealer_id);
  if (!authz.ok) return authz.response;

  // 4. Trial-only.
  if (dealer.account_type !== "Trial") {
    return NextResponse.json(
      { error: "Free trial labels are only available on Trial accounts." },
      { status: 403 },
    );
  }

  // 5. Already claimed (fast path; the atomic claim below is the real guard).
  if (dealer.trial_labels_claimed_at) {
    return NextResponse.json(
      { error: "already_claimed", claimedAt: dealer.trial_labels_claimed_at },
      { status: 409 },
    );
  }

  // 6. Validate SKU.
  const productName = TRIAL_LABEL_PRODUCTS[labelSku];
  if (!productName) {
    return NextResponse.json({ error: "Invalid labelSku" }, { status: 400 });
  }

  // 7. Validate ship-to required fields.
  if (!shipTo || !shipTo.name || !shipTo.address1 || !shipTo.city || !shipTo.state || !shipTo.zip) {
    return NextResponse.json({ error: "Missing required shipping fields" }, { status: 400 });
  }
  const country = shipTo.country || "US";

  // 8. Atomically claim the one-time slot — only one request can flip NULL→now().
  const claimedAt = new Date().toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: claimRow } = await (admin as any)
    .from("dealers")
    .update({ trial_labels_claimed_at: claimedAt })
    .eq("id", dealerUuid)
    .is("trial_labels_claimed_at", null)
    .select("id")
    .maybeSingle();

  if (!claimRow) {
    // Lost the race (or column not yet present) — treat as already claimed.
    return NextResponse.json({ error: "already_claimed" }, { status: 409 });
  }

  // 10. Insert the (free) label order. Cast around the registered Database type
  //     because billed_to/group_id aren't in the generated types yet.
  const orderedByName = dealer.primary_contact ?? dealer.name;
  const { data: orderRow, error: insertErr } = await admin
    .from("label_orders")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .insert({
      dealer_id: dealerUuid,
      ordered_by: claims.sub,
      ordered_by_name: orderedByName,
      items: [
        {
          sku: labelSku,
          qty: FREE_TRIAL_QTY,
          price: 0,
          shipping: "standard",
          productName: `Free Trial Sample — ${productName}`,
        },
      ] as unknown as Record<string, unknown>[],
      ship_to: shipTo as unknown as Record<string, unknown>,
      total_amount: 0,
      billing_status: "skipped", // free — no billing
      email_status: "pending",
      xps_status: "pending",
      billed_to: "dealer",
      group_id: null,
    } as any)
    .select("id")
    .single();

  if (insertErr || !orderRow) {
    console.error("[trial-labels] insert failed:", insertErr?.message);
    // The slot is already claimed; surface a clear error so the dealer can
    // contact support rather than silently losing their one-time sample.
    return NextResponse.json({ error: "Failed to create order record" }, { status: 500 });
  }

  const orderId = (orderRow as { id: string }).id;

  let emailStatus: "sent" | "failed" = "failed";

  // 12. Email Virginia — prominent FREE TRIAL SAMPLE banner so she knows there
  //     is no invoice to generate. Mirrors the orders/labels email template.
  try {
    const to = process.env.VIRGINIA_EMAIL || "assistant@dealeraddendums.com";
    const today = new Date();
    const todayFormatted = formatDateUS(today);
    const subject = `FREE TRIAL SAMPLE — Label Order — ${dealer.name} — ${todayFormatted}`;

    const shipToLines = [
      `<div>${shipTo.name}</div>`,
      shipTo.company ? `<div>${shipTo.company}</div>` : "",
      `<div>${shipTo.address1}</div>`,
      `<div>${shipTo.city}, ${shipTo.state} ${shipTo.zip}</div>`,
      `<div>${country}</div>`,
      shipTo.phone ? `<div>${shipTo.phone}</div>` : "",
    ].filter(Boolean).join("");

    const html = `<!DOCTYPE html>
<html><body style="font-family:Roboto,-apple-system,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:20px">
<div style="background:#ffa500;color:#2a2b3c;font-weight:800;letter-spacing:.04em;text-align:center;padding:12px 16px;border-radius:6px;margin-bottom:16px;font-size:15px">
  🏷 FREE TRIAL SAMPLE — NO INVOICE
</div>
<p style="background:#fff8e1;border:1px solid #ffa500;border-radius:4px;padding:10px 14px;color:#5a4500;margin:0 0 16px">
  This is a one-time free 25-label sample for a Trial dealer. <strong>Do not generate an invoice</strong> — ship only.
</p>
<h2 style="color:#2a2b3c;border-bottom:3px solid #ffa500;padding-bottom:10px">Label Order (Free Trial Sample)</h2>
<table style="width:100%;margin-bottom:16px">
  <tr><td style="color:#78828c;width:140px">Dealer</td><td><strong>${dealer.name}</strong></td></tr>
  <tr><td style="color:#78828c">Internal ID</td><td>${dealer.internal_id ?? "—"}</td></tr>
  <tr><td style="color:#78828c">Ordered by</td><td>${orderedByName}${dealer.primary_contact_email ? ` (${dealer.primary_contact_email})` : ""}</td></tr>
  <tr><td style="color:#78828c">Order date</td><td>${todayFormatted}</td></tr>
</table>
<h3 style="color:#2a2b3c;margin-bottom:8px">Items</h3>
<table style="width:100%;border-collapse:collapse;margin-bottom:16px">
  <thead>
    <tr style="background:#f5f6f7">
      <th style="padding:8px 10px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#78828c">Product</th>
      <th style="padding:8px 10px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#78828c">SKU</th>
      <th style="padding:8px 10px;text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#78828c">Qty</th>
      <th style="padding:8px 10px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#78828c">Shipping</th>
      <th style="padding:8px 10px;text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#78828c">Price</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #e0e0e0">Free Trial Sample — ${productName}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e0e0e0">${labelSku}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e0e0e0;text-align:right">${FREE_TRIAL_QTY}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e0e0e0">Standard</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e0e0e0;text-align:right;font-family:monospace">FREE</td>
    </tr>
  </tbody>
</table>
<h3 style="color:#2a2b3c;margin-bottom:8px">Ship To</h3>
<div style="background:#f5f6f7;padding:12px 16px;border-radius:4px;line-height:1.8">${shipToLines}</div>
</body></html>`;

    await sendMandrillEmail({
      html,
      subject,
      from_email: "noreply@dealeraddendums.com",
      from_name: "DealerAddendums",
      to: [{ email: to, type: "to" }],
    });

    emailStatus = "sent";
    await admin.from("label_orders").update({ email_status: "sent" }).eq("id", orderId);
  } catch (err) {
    console.error("[trial-labels] email step threw:", err instanceof Error ? err.message : err);
    emailStatus = "failed";
    await admin.from("label_orders").update({ email_status: "failed" }).eq("id", orderId).then(undefined, () => {});
  }

  // 11/Step 3: Stage for the XPS pull model (same as orders/labels). XPS polls
  // List Orders, prints, and fires the Update Order webhook back with tracking.
  const xpsOrderId = `DA-${dealer.internal_id}-${Date.now()}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: xpsStageErr } = await (admin as any)
    .from("label_orders")
    .update({ xps_status: "pending_pull", xps_order_id: xpsOrderId })
    .eq("id", orderId);
  let xpsStatus: "created" | "failed" = "created";
  if (xpsStageErr) {
    console.error("[trial-labels] failed to stage order for XPS pull:", xpsStageErr.message);
    xpsStatus = "failed";
  }

  return NextResponse.json({
    success: true,
    orderId,
    email: emailStatus,
    xps: xpsStatus,
    claimedAt,
  });
}
