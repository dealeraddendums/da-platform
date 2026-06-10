// Shared, authenticated invoice view/download for the Billing tabs (#108).
// Spec: docs/dealer-invoice-view-download.md. The caller (one route per billing
// context) resolves the customerKey using the SAME auth as that context's
// invoice LIST, then calls streamInvoice — so view/download can never be
// broader than what the user already sees in the list.

import { NextResponse } from "next/server";
import { listInvoices, fetchInvoiceHtml } from "@/lib/billing";
import { renderViaService, useService } from "@/lib/pdf-service-client";

/**
 * Ownership-gated invoice proxy.
 *  - Ownership: invoiceId must be in listInvoices(customerKey) → else 403.
 *    (The list is the gate: "if you can see the row, you can get the doc.")
 *  - download=false → return da-billing's invoice HTML (opens in a new tab).
 *  - download=true  → HTML → da-pdf-service → stream a real application/pdf
 *    with a clean invoice-{number}.pdf filename. The browser never sees
 *    da-billing's public URL or the pdf-service private IP.
 */
export async function streamInvoice(
  customerKey: string | null,
  invoiceId: string,
  download: boolean,
): Promise<NextResponse> {
  if (!customerKey) {
    return NextResponse.json({ error: "No billing account for this context" }, { status: 404 });
  }

  let inv;
  try {
    const { invoices } = await listInvoices(customerKey);
    inv = invoices.find((i) => i.id === invoiceId);
  } catch (err) {
    return NextResponse.json(
      { error: `Could not verify the invoice: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
  if (!inv) {
    // Not in this customer's list → not theirs to see. Ownership gate.
    return NextResponse.json({ error: "Invoice not found for this account" }, { status: 403 });
  }

  let html: string;
  try {
    html = await fetchInvoiceHtml(invoiceId);
  } catch (err) {
    return NextResponse.json(
      { error: `Could not load the invoice: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  if (!download) {
    return new NextResponse(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  if (!useService()) {
    return NextResponse.json({ error: "PDF service not available" }, { status: 503 });
  }

  const num = String(inv.invoiceNumber ?? invoiceId.slice(0, 8)).replace(/[^A-Za-z0-9._-]/g, "");
  try {
    const { buffer } = await renderViaService(
      html,
      { customDims: { widthIn: 8.5, heightIn: 11 }, allPages: true, docType: "addendum" },
      `invoices/invoice-${num}_${Date.now()}.pdf`,
    );
    return new NextResponse(buffer as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="invoice-${num}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `PDF render failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}
