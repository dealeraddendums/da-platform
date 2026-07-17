export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { checkPdfExists } from "@/lib/addendum";
import {
  PLATFORM_BUTTON_CSS,
  sanitizeButtonCss,
  publicSupabase,
  resolveWidgetVehicle,
  resolveDealerParam,
  getIntegration,
  getVehicleOptions,
  escapeHtml,
  empty200,
  html200,
  corsPreflight,
} from "@/lib/website-integrations";

// Public widget endpoint — replaces the legacy API Portal /generate-addendum.
// text/html, CORS *, Supabase-only. 5.0-only by construction (a VIN not in
// dealer_vehicles → empty body). Options come from vehicle_options (the live
// 5.0 table the Builder/print engine use), NOT the legacy addendum_data.

function fmt(val: string | number | null): string {
  if (val === null || val === undefined || val === "") return "";
  const n = typeof val === "string" ? parseFloat(val.replace(/[^0-9.]/g, "")) : val;
  return isNaN(n) ? String(val) : "$" + n.toLocaleString("en-US");
}

export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(
  request: NextRequest,
  { params }: { params: { vin: string; theme: string } },
) {
  const vin = params.vin;
  const theme = params.theme;
  const { searchParams } = request.nextUrl;
  const stock = searchParams.get("stock");
  const feature = searchParams.get("feature") || "both";
  const textOverride = searchParams.get("text");
  const dealerParam = searchParams.get("dealer");

  const sb = publicSupabase();

  // Optional ?dealer= scopes the VIN lookup (dealer trades can put the same
  // VIN under two dealers). Unknown dealer value → empty, like missing data.
  let dealerScope: string | null = null;
  if (dealerParam) {
    dealerScope = await resolveDealerParam(sb, dealerParam);
    if (!dealerScope) return empty200();
  }

  // 1. Resolve the vehicle (→ id + dealer_id + pricing). No match → empty.
  const vehicle = await resolveWidgetVehicle(sb, vin, stock, dealerScope);
  if (!vehicle) return empty200();

  // 2. Dealer's dealer_com integration config. Disabled → nothing renders.
  const integration = await getIntegration(sb, vehicle.dealer_id);
  if (integration && !integration.enabled) return empty200();

  // Account value wins: the dealer's saved button_label takes precedence over a
  // caller-supplied ?text= override, so DDC needs no per-dealer customization.
  const buttonLabel = integration?.button_label || textOverride || "Download Addendum";
  // Dealer CSS is sanitized: this <style> block is served cross-origin to
  // dealer websites, so tag-breakouts/@import/expression()/non-https url()
  // are stripped before injection.
  const buttonCss = integration?.button_css ? sanitizeButtonCss(integration.button_css) : PLATFORM_BUTTON_CSS;

  // 3. Pricing block (feature=pricing|both, when data exists).
  let pricingHtml = "";
  if (feature === "pricing" || feature === "both") {
    const options = await getVehicleOptions(sb, vehicle.id);
    const msrpRow = vehicle.msrp
      ? `<li class="dealer-addendums__pricing__msrp"><span class="dealer-addendums__pricing__label">MSRP</span><span class="dealer-addendums__pricing__value">${fmt(vehicle.msrp)}</span></li>`
      : "";
    const ipRow = vehicle.internet_price
      ? `<li class="dealer-addendums__pricing__internet-price"><span class="dealer-addendums__pricing__label">Internet Price</span><span class="dealer-addendums__pricing__value">${fmt(vehicle.internet_price)}</span></li>`
      : "";
    const optionRows = options
      .map(
        (o) =>
          `<li class="dealer-addendums__pricing__option"><span class="dealer-addendums__pricing__label">${escapeHtml(o.option_name)}</span><span class="dealer-addendums__pricing__value">${escapeHtml(fmt(o.option_price))}</span></li>`,
      )
      .join("");

    if (msrpRow || ipRow || optionRows) {
      pricingHtml = `<div class="dealer-addendums__pricing"><ul class="dealer-addendums__pricing__list">${msrpRow}${ipRow}${optionRows}</ul></div>`;
    }
  }

  // 4. Button block (feature=button|both, when the PDF exists in S3).
  let buttonHtml = "";
  if (feature === "button" || feature === "both") {
    const pdfUrl = await checkPdfExists(vin.toUpperCase());
    if (pdfUrl) {
      buttonHtml = `<a href="${pdfUrl}" class="dealer-addendums__button__download-button" target="_blank">${escapeHtml(buttonLabel)}</a>`;
    }
  }

  // 5. Nothing to show → empty.
  if (!pricingHtml && !buttonHtml) return empty200();

  return html200(`<div class="${escapeHtml(theme)}"><style>${buttonCss}</style>${pricingHtml}${buttonHtml}</div>`);
}
