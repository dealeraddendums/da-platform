import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/aurora";
import { checkPdfExists, buildButtonHtml } from "@/lib/addendum";
import type { RowDataPacket } from "mysql2/promise";

// Public endpoint — returns HTML embed. No JWT required.
// Called via script/iframe on dealer inventory pages.

type Params = { params: { vin: string; theme: string } };

function formatCurrency(val: string | number | null): string {
  const n = parseFloat(String(val || 0));
  return isNaN(n) ? "$0.00" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const vin = params.vin.toUpperCase();
  const theme = params.theme;
  const feature = req.nextUrl.searchParams.get("feature") ?? "";
  const stock = req.nextUrl.searchParams.get("stock") ?? "";
  const text = req.nextUrl.searchParams.get("text") || "Download Addendum";
  const safeTheme = theme.replace(/[^a-zA-Z0-9_-]/g, "");

  const pdfUrl = await checkPdfExists(vin);

  // feature=pricing or feature=both — include pricing HTML with options table
  if ((feature === "pricing" || feature === "both") && stock) {
    try {
      const pool = getPool();
      const [vehicleRows] = await pool.query<RowDataPacket[]>(
        "SELECT MSRP, INTERNET_PRICE FROM dealer_inventory WHERE VIN_NUMBER = ? AND STOCK_NUMBER = ? LIMIT 1",
        [vin, stock]
      );
      const [optionRows] = await pool.query<RowDataPacket[]>(
        "SELECT ITEM_NAME, ITEM_DESCRIPTION, ITEM_PRICE FROM addendum_data WHERE VIN_NUMBER = ? AND ACTIVE = '1' ORDER BY RE_ORDER, _ID",
        [vin]
      );

      const v = vehicleRows[0];
      const msrp = v ? formatCurrency(v.MSRP) : "$0.00";
      const internetPrice = v ? formatCurrency(v.INTERNET_PRICE) : "$0.00";

      const optionsHtml = (optionRows as RowDataPacket[]).map((o) =>
        `<li>${o.ITEM_NAME}: ${o.ITEM_DESCRIPTION} — ${formatCurrency(o.ITEM_PRICE)}</li>`
      ).join("");

      const pricingHtml = `<div class="dealer-addendums__pricing">
  <div class="dealer-addendums__price-row"><span class="dealer-addendums__price-label">MSRP</span><span class="dealer-addendums__price-value">${msrp}</span></div>
  <div class="dealer-addendums__price-row"><span class="dealer-addendums__price-label">Internet Price</span><span class="dealer-addendums__price-value">${internetPrice}</span></div>
  <ul class="dealer-addendums__options">${optionsHtml}</ul>
</div>`;

      const buttonHtml = pdfUrl ? `\n<a href="${pdfUrl}" class="dealer-addendums__button__download-button" target="_blank">${text}</a>` : "";
      const html = `<div class="${safeTheme}">${pricingHtml}${feature === "both" ? buttonHtml : ""}</div>`;

      return new NextResponse(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
    } catch {
      // Fall through to simple button on Aurora error
    }
  }

  // Default: simple download button (or empty if no PDF)
  if (!pdfUrl) {
    return new NextResponse("", { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  return new NextResponse(buildButtonHtml(safeTheme, pdfUrl, text), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
