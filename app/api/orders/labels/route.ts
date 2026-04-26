import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { sendMandrillEmail } from "@/lib/mandrill";

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

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  // dealer_admin only
  if (claims.role !== 'dealer_admin' && claims.role !== 'super_admin') {
    return NextResponse.json({ error: 'Forbidden — dealer_admin required' }, { status: 403 });
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

  // Write initial record
  const { data: orderRow, error: insertErr } = await admin
    .from('label_orders')
    .insert({
      dealer_id: dealerId,
      ordered_by: claims.sub,
      items: items as unknown as Record<string, unknown>[],
      ship_to: shipTo as unknown as Record<string, unknown>,
      total_amount: totalAmount,
      billing_status: 'pending',
      email_status: 'pending',
      xps_status: 'pending',
    })
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

  // ── Step 1: da-billing template update ───────────────────────────────────────
  const billingKey = process.env.BILLING_API_KEY;
  if (!billingKey) {
    console.warn('[orders/labels] BILLING_API_KEY not set — skipping billing step');
    billingStatus = 'skipped';
    await admin.from('label_orders').update({ billing_status: 'skipped' }).eq('id', orderId);
  } else {
    try {
      const tmplRes = await fetch(`${BILLING_BASE}/templates/customer/${internalDealerId}`, {
        headers: { 'X-API-Key': billingKey },
      });

      if (tmplRes.status === 404 || !tmplRes.ok) {
        console.warn('[orders/labels] no billing template for dealer', internalDealerId);
        billingStatus = 'failed';
        await admin.from('label_orders').update({ billing_status: 'failed' }).eq('id', orderId);
      } else {
        const tmplData = await tmplRes.json() as { template?: { products?: unknown[] } | null };
        if (!tmplData.template) {
          console.warn('[orders/labels] billing template is null for dealer', internalDealerId);
          billingStatus = 'failed';
          await admin.from('label_orders').update({ billing_status: 'failed' }).eq('id', orderId);
        } else {
          const existingProducts: unknown[] = tmplData.template.products ?? [];
          const newProducts = items.map(item => ({
            productId: 'label-order',
            quantity: 1,
            price: item.price,
            discount: 0,
            lineItemDescription: `${internalDealerId}::${dealerName}`,
            labelType: item.sku,
            labelQuantity: String(item.qty),
          }));
          const updatedProducts = [...existingProducts, ...newProducts];

          const putRes = await fetch(`${BILLING_BASE}/templates/${internalDealerId}`, {
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
        }
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
          city: process.env.XPS_SENDER_CITY ?? '',
          state: process.env.XPS_SENDER_STATE ?? '',
          zip: process.env.XPS_SENDER_ZIP ?? '',
          country: 'US',
        },
        receiver: {
          name: shipTo.name,
          company: shipTo.company || shipTo.attention || '',
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
          quantity: 1,
          weight: '1.0',
          lineId: String(i + 1),
        })),
        packages: [{ weight: '1.0', length: null, width: null, height: null, insuranceAmount: null, declaredValue: null }],
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
  const success = emailStatus === 'sent';
  const failures: string[] = [];
  if (billingStatus === 'failed') failures.push('billing');
  if (emailStatus === 'failed') failures.push('email notification');
  if (xpsStatus === 'failed') failures.push('shipping order');

  let message: string;
  if (success && failures.length === 0) {
    message = 'Order placed successfully.';
  } else if (success) {
    message = `Order received. Failed steps: ${failures.join(', ')}.`;
  } else {
    message = 'Order failed — email notification not sent.';
  }

  return NextResponse.json({ success, orderId, billing: billingStatus, email: emailStatus, xps: xpsStatus, message });
}
