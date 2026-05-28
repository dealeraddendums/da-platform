import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { sendMandrillEmail } from "@/lib/mandrill";
import { getLabelWeightLbs, getOrderWeightLbs } from "@/lib/label-weights";

// DA Platform SKU -> da-billing labelType slug. da-billing's price
// resolver keys off these slugs (size + finish), not our SKUs or the
// product display names. Keep in sync with da-billing's label price
// table.
const SKU_TO_LABEL_TYPE: Record<string, string> = {
  '8300-1': '4.25x11-standard',
  '9300-1': '4.25x11-waterproof',
  '8300-3': '3.125x11-standard',
  '9300-3': '3.125x11-waterproof',
  '8300':   '8.5x11-standard',
  '9300':   '8.5x11-waterproof',
};

interface OrderItem {
  sku: string;
  qty: number;
  price: number;
  shipping: 'standard' | 'fedex';
  productName: string;
}

interface ShipTo {
  name: string;
  company?: string;
  attention?: string;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string;
}

interface OrderBody {
  items: OrderItem[];
  shipTo: ShipTo;
  dealerId: string;
  dealerName: string;
  internalDealerId: string;
  orderedByName: string;
  orderedByEmail: string;
}

function addBusinessDays(date: Date, days: number): Date {
  const result = new Date(date);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    const day = result.getDay();
    if (day !== 0 && day !== 6) added++;
  }
  return result;
}

function toISODate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function formatDateUS(date: Date): string {
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}

const BILLING_BASE = 'https://billing.dealeraddendums.com/api/v1';

/**
 * GET /api/orders/labels
 *
 * Returns recent label_orders for the current dealer (or any dealer when
 * called by super_admin/group_admin with ?dealer_id=<UUID>). Used by the
 * Orders tab on /profile to display status + tracking links.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient();
  let dealerUuid: string | null = null;

  if (claims.role === 'dealer_admin' || claims.role === 'dealer_user') {
    if (!claims.dealer_id) {
      return NextResponse.json({ error: 'No dealer assigned' }, { status: 403 });
    }
    const { data: drow } = await admin
      .from('dealers')
      .select('id')
      .eq('dealer_id', claims.dealer_id)
      .maybeSingle<{ id: string }>();
    dealerUuid = drow?.id ?? null;
  } else if (claims.role === 'super_admin' || claims.role === 'group_admin') {
    const param = req.nextUrl.searchParams.get('dealer_id');
    if (param) dealerUuid = param;
  }

  if (!dealerUuid) {
    return NextResponse.json({ data: [] });
  }

  const { data, error: dbErr } = await admin
    .from('label_orders')
    .select('id, dealer_id, items, ship_to, total_amount, billed_to, group_id, billing_status, email_status, xps_status, xps_order_id, xps_tracking_number, created_at')
    .eq('dealer_id', dealerUuid)
    .order('created_at', { ascending: false })
    .limit(100);

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  // Roles that can place a label order. Mirrors the Order Supplies
  // sidebar entry (dealer_admin / dealer_user / dealer_restricted) plus
  // super_admin / group_admin so impersonation works — when a
  // super_admin ghosts into a dealer the JWT carries the impersonated
  // role, which may be any of the three dealer tiers OR group_admin if
  // they entered through a group context.
  const ALLOWED_ROLES = new Set(['dealer_admin', 'dealer_user', 'dealer_restricted', 'super_admin', 'group_admin']);
  if (!ALLOWED_ROLES.has(claims.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: OrderBody;
  try {
    body = await req.json() as OrderBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { items, shipTo, dealerId, dealerName, internalDealerId, orderedByName, orderedByEmail } = body;

  if (!items?.length || !shipTo || !dealerId) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const today = new Date();
  const totalAmount = items.reduce((s, i) => s + i.price, 0);

  // Look up the dealer's labels-billing config so we can route to the
  // correct customer + decide between a template append and a one-time
  // invoice. billed_to / group_id are persisted on the label_orders row
  // for the Orders tab.
  const { data: dealerCfg } = await admin
    .from('dealers')
    .select('name, primary_contact, primary_contact_email, labels_billed_to, group_id, billing_customer_id, internal_id')
    .eq('id', dealerId)
    .maybeSingle<{
      name: string;
      primary_contact: string | null;
      primary_contact_email: string | null;
      labels_billed_to: 'dealer' | 'group';
      group_id: string | null;
      billing_customer_id: string | null;
      internal_id: string | null;
    }>();
  const labelsBilledTo: 'dealer' | 'group' = dealerCfg?.labels_billed_to === 'group' ? 'group' : 'dealer';
  const billedToGroupId = labelsBilledTo === 'group' ? (dealerCfg?.group_id ?? null) : null;

  // ── Case 4: Free/Trial dealer — labels billed to dealer, no group,
  //           no billing_customer_id → reject the order BEFORE we insert
  //           it. These dealers aren't entitled to labels.
  if (
    labelsBilledTo === 'dealer'
    && !dealerCfg?.billing_customer_id
    && !dealerCfg?.group_id
  ) {
    return NextResponse.json(
      {
        error: 'Label orders are not available on your current plan. Please contact DealerAddendums to upgrade.',
      },
      { status: 403 },
    );
  }

  // Resolve the billing customer key (the recipient of the template PUT
  // OR the invoice POST below).
  let billingCustomerKey: string | null = null;
  if (labelsBilledTo === 'group' && billedToGroupId) {
    const { data: grp } = await admin
      .from('groups')
      .select('billing_customer_id')
      .eq('id', billedToGroupId)
      .maybeSingle<{ billing_customer_id: string | null }>();
    billingCustomerKey = grp?.billing_customer_id ?? null;
  } else {
    billingCustomerKey = dealerCfg?.billing_customer_id ?? null;
  }

  // Write initial record. Cast around the registered Database type because
  // migrations 067/068 added billed_to and group_id columns that aren't in
  // the generated types yet.
  const { data: orderRow, error: insertErr } = await admin
    .from('label_orders')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .insert({
      dealer_id: dealerId,
      ordered_by: claims.sub,
      items: items as unknown as Record<string, unknown>[],
      ship_to: shipTo as unknown as Record<string, unknown>,
      total_amount: totalAmount,
      billing_status: 'pending',
      email_status: 'pending',
      xps_status: 'pending',
      billed_to: labelsBilledTo,
      group_id: billedToGroupId,
    } as any)
    .select('id')
    .single();

  if (insertErr || !orderRow) {
    console.error('[orders/labels] insert failed:', insertErr?.message);
    return NextResponse.json({ error: 'Failed to create order record' }, { status: 500 });
  }

  const orderId = (orderRow as { id: string }).id;

  let billingStatus: 'written' | 'failed' | 'skipped' = 'skipped';
  let emailStatus: 'sent' | 'failed' = 'failed';
  let xpsStatus: 'created' | 'failed' = 'failed';

  // ── Step 1: da-billing routing ───────────────────────────────────────────────
  // Three cases left after the Case 4 early reject above:
  //   1. labels_billed_to=group  → append to group template
  //   2. labels_billed_to=dealer + active template → append to dealer template
  //   3. labels_billed_to=dealer + group but no template (subscription
  //      moved to group) → one-time invoice to the dealer
  //
  // Cases 1+2 share the template-append flow. Case 3 falls through when
  // the GET /templates/customer/:id call returns 404 AND the dealer is
  // in a group.
  const billingKey = process.env.BILLING_API_KEY;
  if (!billingKey) {
    console.warn('[orders/labels] BILLING_API_KEY not set — skipping billing step');
    billingStatus = 'skipped';
    await admin.from('label_orders').update({ billing_status: 'skipped' }).eq('id', orderId);
  } else {
    try {
      // Template-append flow (Cases 1 + 2). Always try this first if we
      // have a customer key. Case 3 detection happens when the GET
      // returns 404 below.
      const templateAvailable = await (async (): Promise<{ ok: true; existing: unknown[] } | { ok: false; status: number }> => {
        if (!billingCustomerKey) return { ok: false, status: 404 };
        const res = await fetch(`${BILLING_BASE}/templates/customer/${billingCustomerKey}`, {
          headers: { 'X-API-Key': billingKey },
        });
        if (res.status === 404) return { ok: false, status: 404 };
        if (!res.ok) return { ok: false, status: res.status };
        const tmplData = await res.json() as { template?: { products?: unknown[] } | null };
        if (!tmplData.template) return { ok: false, status: 404 };
        return { ok: true, existing: tmplData.template.products ?? [] };
      })();

      if (templateAvailable.ok) {
        // Case 1 + 2: append labels line items to the existing template.
        // DA Platform never sends price on template line items — da-billing
        // resolves the canonical price from labelType + labelQuantity at
        // invoice time.
        //
        // Dedup: strip any prior labels line for this dealer before
        // appending. Match on productId === 'labels' AND
        // lineItemDescription starting with "<internal_id>::" so a
        // re-order REPLACES the previous template entry instead of
        // duplicating it. Group templates can carry label lines for
        // many dealers — the prefix check keeps us scoped to the
        // ordering dealer only.
        const dealerPrefix = `${internalDealerId}::`;
        const filteredExisting = (templateAvailable.existing as Array<Record<string, unknown>>).filter(p => {
          const isLabels = p.productId === 'labels';
          const desc = typeof p.lineItemDescription === 'string' ? p.lineItemDescription : '';
          const tagsThisDealer = desc.startsWith(dealerPrefix);
          return !(isLabels && tagsThisDealer);
        });
        const newProducts = items.map(item => ({
          productId: 'labels',
          quantity: 1,
          discount: 0,
          // Tag the line with dealer + SKU so each label type is a
          // distinct entry. da-billing's within-template duplicate
          // check fires when two lines share productId AND
          // lineItemDescription, so appending the SKU keeps each
          // label-type line unique. The dealer-prefix portion stays
          // first so the dedup filter above (startsWith
          // "${internalDealerId}::") still sweeps all of this
          // dealer's prior labels lines on re-order.
          lineItemDescription: `${internalDealerId}::${dealerName}::${item.sku}`,
          labelType: SKU_TO_LABEL_TYPE[item.sku] ?? item.sku,
          labelQuantity: String(item.qty),
        }));
        const updatedProducts = [...filteredExisting, ...newProducts];
        const putRes = await fetch(`${BILLING_BASE}/templates/${billingCustomerKey}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': billingKey },
          body: JSON.stringify({ products: updatedProducts }),
        });
        if (putRes.ok) {
          billingStatus = 'written';
          await admin.from('label_orders').update({ billing_status: 'written' }).eq('id', orderId);
        } else {
          const errText = await putRes.text().catch(() => '');
          console.error('[orders/labels] billing PUT failed:', putRes.status, errText);
          billingStatus = 'failed';
          await admin.from('label_orders').update({ billing_status: 'failed' }).eq('id', orderId);
        }
      } else if (
        labelsBilledTo === 'dealer'
        && dealerCfg?.group_id
        && templateAvailable.status === 404
      ) {
        // Case 3: dealer is in a group but has no active template (their
        // subscription moved to the group template). Generate a one-time
        // invoice to the dealer.
        let invoiceCustomerId = dealerCfg.billing_customer_id;
        if (!invoiceCustomerId) {
          // Create a minimal customer record first.
          const createRes = await fetch(`${BILLING_BASE}/customers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': billingKey },
            body: JSON.stringify({
              name: dealerCfg.primary_contact ?? dealerCfg.name,
              company: dealerCfg.name,
              email: dealerCfg.primary_contact_email ?? '',
              isGroup: false,
            }),
          });
          if (!createRes.ok) {
            const errText = await createRes.text().catch(() => '');
            console.error('[orders/labels] one-time invoice customer create failed:', createRes.status, errText);
            billingStatus = 'failed';
            await admin.from('label_orders').update({ billing_status: 'failed' }).eq('id', orderId);
          } else {
            const created = await createRes.json() as { customer?: { id?: string }; id?: string };
            invoiceCustomerId = created.customer?.id ?? created.id ?? null;
            if (invoiceCustomerId) {
              await admin.from('dealers').update({ billing_customer_id: invoiceCustomerId }).eq('id', dealerId);
            }
          }
        }

        if (invoiceCustomerId) {
          const invoiceItems = items.map(item => ({
            description: `Labels — ${item.productName} x${item.qty} (${dealerName})`,
            quantity: 1,
            // One-time invoice: price IS the line amount (da-billing
            // computes subtotal as quantity * price). The recurring-
            // template "no price" rule doesn't apply here because
            // there's no template at invoice time.
            price: item.price,
          }));
          const invRes = await fetch(`${BILLING_BASE}/invoices`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': billingKey },
            body: JSON.stringify({
              customerId: invoiceCustomerId,
              items: invoiceItems,
              notes: `One-time label order — dealer subscription is billed through group.`,
            }),
          });
          if (invRes.ok) {
            billingStatus = 'written';
            await admin.from('label_orders').update({ billing_status: 'written' }).eq('id', orderId);
          } else {
            const errText = await invRes.text().catch(() => '');
            console.error('[orders/labels] one-time invoice POST failed:', invRes.status, errText);
            billingStatus = 'failed';
            await admin.from('label_orders').update({ billing_status: 'failed' }).eq('id', orderId);
          }
        }
      } else {
        // Template missing, but not the Case-3 group+dealer fallback.
        // Most likely a misconfigured customer key. Mark failed for
        // super_admin review.
        console.warn('[orders/labels] no billing template for customer', billingCustomerKey, 'and no Case 3 fallback');
        billingStatus = 'failed';
        await admin.from('label_orders').update({ billing_status: 'failed' }).eq('id', orderId);
      }
    } catch (err) {
      console.error('[orders/labels] billing step threw:', err instanceof Error ? err.message : err);
      billingStatus = 'failed';
      await admin.from('label_orders').update({ billing_status: 'failed' }).eq('id', orderId).then(undefined, () => {});
    }
  }

  // ── Step 2: Mandrill email ────────────────────────────────────────────────────
  try {
    const to = process.env.VIRGINIA_EMAIL || 'virginia@dealeraddendums.com';
    const todayFormatted = formatDateUS(today);
    const subject = `Label Order — ${dealerName} — ${todayFormatted}`;

    const itemRows = items.map(item => `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #e0e0e0">${item.productName}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e0e0e0">${item.sku}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e0e0e0;text-align:right">${item.qty.toLocaleString()}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e0e0e0">${item.shipping === 'fedex' ? 'FedEx' : 'Standard'}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e0e0e0;text-align:right;font-family:monospace">$${item.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      </tr>`).join('');

    const shipToLines = [
      shipTo.attention ? `<div>Attn: ${shipTo.attention}</div>` : '',
      `<div>${shipTo.name}</div>`,
      shipTo.company ? `<div>${shipTo.company}</div>` : '',
      `<div>${shipTo.address1}</div>`,
      shipTo.address2 ? `<div>${shipTo.address2}</div>` : '',
      `<div>${shipTo.city}, ${shipTo.state} ${shipTo.zip}</div>`,
      `<div>${shipTo.country}</div>`,
      shipTo.phone ? `<div>${shipTo.phone}</div>` : '',
    ].filter(Boolean).join('');

    const html = `<!DOCTYPE html>
<html><body style="font-family:Roboto,-apple-system,sans-serif;color:#333;max-width:600px;margin:0 auto;padding:20px">
<h2 style="color:#2a2b3c;border-bottom:3px solid #ffa500;padding-bottom:10px">Label Order</h2>
<table style="width:100%;margin-bottom:16px">
  <tr><td style="color:#78828c;width:140px">Dealer</td><td><strong>${dealerName}</strong></td></tr>
  <tr><td style="color:#78828c">Internal ID</td><td>${internalDealerId}</td></tr>
  <tr><td style="color:#78828c">Ordered by</td><td>${orderedByName} (${orderedByEmail})</td></tr>
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
  <tbody>${itemRows}</tbody>
  <tfoot>
    <tr style="background:#f5f6f7;font-weight:700">
      <td colspan="4" style="padding:8px 10px;text-align:right">Total</td>
      <td style="padding:8px 10px;text-align:right;font-family:monospace">$${totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
    </tr>
  </tfoot>
</table>
<h3 style="color:#2a2b3c;margin-bottom:8px">Ship To</h3>
<div style="background:#f5f6f7;padding:12px 16px;border-radius:4px;line-height:1.8">${shipToLines}</div>
</body></html>`;

    await sendMandrillEmail({
      html,
      subject,
      from_email: 'noreply@dealeraddendums.com',
      from_name: 'DealerAddendums',
      to: [{ email: to, type: 'to' }],
    });

    emailStatus = 'sent';
    await admin.from('label_orders').update({ email_status: 'sent' }).eq('id', orderId);
  } catch (err) {
    console.error('[orders/labels] email step threw:', err instanceof Error ? err.message : err);
    emailStatus = 'failed';
    await admin.from('label_orders').update({ email_status: 'failed' }).eq('id', orderId).then(undefined, () => {});
  }

  // ── Step 3: XPS Shipper ───────────────────────────────────────────────────────
  const xpsKey = process.env.XPS_API_KEY;
  const xpsCustomerId = process.env.XPS_CUSTOMER_ID;
  const xpsIntegrationId = process.env.XPS_INTEGRATION_ID;

  if (!xpsKey || !xpsCustomerId || !xpsIntegrationId) {
    console.warn('[orders/labels] XPS env vars not set — skipping XPS step');
    xpsStatus = 'failed';
    await admin.from('label_orders').update({ xps_status: 'failed' }).eq('id', orderId).then(undefined, () => {});
  } else {
    try {
      const xpsOrderId = `DA-${internalDealerId}-${Date.now()}`;
      const dueDate = addBusinessDays(today, 3);

      const xpsBody = {
        orderId: xpsOrderId,
        orderDate: toISODate(today),
        orderNumber: xpsOrderId,
        fulfillmentStatus: 'pending',
        shippingService: items.some(i => i.shipping === 'fedex') ? 'FedEx' : 'Standard',
        shippingTotal: '0.00',
        weightUnit: 'lb',
        dimUnit: 'in',
        dueByDate: toISODate(dueDate),
        orderGroup: 'DealerAddendums',
        contentDescription: items.map(i => `${i.productName} x${i.qty}`).join(', '),
        sender: {
          name: process.env.XPS_SENDER_NAME ?? '',
          company: process.env.XPS_SENDER_COMPANY ?? '',
          address1: process.env.XPS_SENDER_ADDRESS1 ?? '',
          address2: '',
          city: process.env.XPS_SENDER_CITY ?? '',
          state: process.env.XPS_SENDER_STATE ?? '',
          zip: process.env.XPS_SENDER_ZIP ?? '',
          country: 'US',
          phone: process.env.XPS_SENDER_PHONE ?? '',
        },
        receiver: {
          // XPS expects "name" = person, "company" = business.
          // shipTo.name is the dealership name (collected from the
          // dealer record), so it belongs in company. The receiver
          // person is the attention contact when one was entered in
          // the order form, otherwise the dealer's primary_contact.
          name: shipTo.attention || dealerCfg?.primary_contact || '',
          company: shipTo.name,
          address1: shipTo.address1,
          address2: shipTo.address2 || '',
          city: shipTo.city,
          state: shipTo.state,
          zip: shipTo.zip,
          country: shipTo.country || 'US',
          phone: shipTo.phone || '',
        },
        shipperReference: shipTo.attention || null,
        items: items.map((item, i) => ({
          productId: item.sku,
          sku: item.sku,
          title: item.productName,
          price: String(item.price),
          quantity: item.qty,
          weight: String(getLabelWeightLbs(item.sku)),
          lineId: String(i + 1),
          imgUrl: '',
          htsNumber: '',
          countryOfOrigin: 'US',
        })),
        // Package weight is the sum of every line's SKU weight. lib/label-weights
        // is the source of truth — see that file for the SKU table.
        packages: [{ weight: String(getOrderWeightLbs(items)), length: null, width: null, height: null, insuranceAmount: null, declaredValue: null }],
      };

      const xpsRes = await fetch(
        `https://xpsshipper.com/restapi/v1/customers/${xpsCustomerId}/integrations/${xpsIntegrationId}/orders/${xpsOrderId}`,
        {
          method: 'PUT',
          headers: { 'Authorization': `RSIS ${xpsKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(xpsBody),
        }
      );

      if (xpsRes.status === 201 || xpsRes.ok) {
        xpsStatus = 'created';
        await admin.from('label_orders')
          .update({ xps_status: 'created', xps_order_id: xpsOrderId })
          .eq('id', orderId);
      } else {
        const errText = await xpsRes.text().catch(() => '');
        console.error('[orders/labels] XPS PUT failed:', xpsRes.status, errText);
        xpsStatus = 'failed';
        await admin.from('label_orders').update({ xps_status: 'failed' }).eq('id', orderId).then(undefined, () => {});
      }
    } catch (err) {
      console.error('[orders/labels] XPS step threw:', err instanceof Error ? err.message : err);
      xpsStatus = 'failed';
      await admin.from('label_orders').update({ xps_status: 'failed' }).eq('id', orderId).then(undefined, () => {});
    }
  }

  // ── Build response ────────────────────────────────────────────────────────────
  // `message` is the human-readable string the Order Supplies UI renders
  // verbatim in the dealer's success card. Billing-side failures are a
  // DA-internal concern (template-write race, missing dealer template,
  // etc.) — they don't change what the dealer needs to do next and must
  // never surface here. The structured `billing` field below stays in the
  // response for internal/admin consumers (server logs, support tooling)
  // that inspect the JSON.
  const success = emailStatus === 'sent';
  const dealerFacingFailures: string[] = [];
  if (emailStatus === 'failed') dealerFacingFailures.push('email notification');
  if (xpsStatus === 'failed')   dealerFacingFailures.push('shipping order');

  let message: string;
  if (success && dealerFacingFailures.length === 0) {
    message = 'Order placed successfully.';
  } else if (success) {
    message = `Order received. Failed steps: ${dealerFacingFailures.join(', ')}.`;
  } else {
    message = 'Order failed — email notification not sent.';
  }

  return NextResponse.json({ success, orderId, billing: billingStatus, email: emailStatus, xps: xpsStatus, message });
}
