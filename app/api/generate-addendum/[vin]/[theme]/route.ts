import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { checkPdfExists, buildButtonHtml } from "@/lib/addendum";

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
    const admin = createAdminSupabaseClient();
    const { data: vehicle } = await admin
      .from("dealer_vehicles")
      .select("id, msrp, internet_price")
      .eq("vin", vin)
      .eq("stock_number", stock)
      .maybeSingle();

    if (vehicle) {
      const { data: optRows } = await admin
        .from("vehicle_options")
        .select("option_name, description, option_price")
        .eq("vehicle_id", vehicle.id)
        .order("sort_order", { ascending: true });

      const msrp = vehicle.msrp ? formatCurrency(vehicle.msrp) : "$0.00";
      const internetPrice = vehicle.internet_price ? formatCurrency(vehicle.internet_price) : msrp;

      const optionsHtml = (optRows ?? []).map((o) =>
        `<li>${o.option_name}: ${o.description ?? ""} — ${formatCurrency(o.option_price)}</li>`
      ).join("");

      const pricingHtml = `<div class="dealer-addendums__pricing">
  <div class="dealer-addendums__price-row"><span class="dealer-addendums__price-label">MSRP</span><span class="dealer-addendums__price-value">${msrp}</span></div>
  <div class="dealer-addendums__price-row"><span class="dealer-addendums__price-label">Internet Price</span><span class="dealer-addendums__price-value">${internetPrice}</span></div>
  <ul class="dealer-addendums__options">${optionsHtml}</ul>
</div>`;

      const buttonHtml = pdfUrl ? `\n<a href="${pdfUrl}" class="dealer-addendums__button__download-button" target="_blank">${text}</a>` : "";
      const html = `<div class="${safeTheme}">${pricingHtml}${feature === "both" ? buttonHtml : ""}</div>`;

      return new NextResponse(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    // Vehicle not found — fall through to simple button
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
