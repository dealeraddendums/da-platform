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
  escapeHtml,
  empty200,
  html200,
  corsPreflight,
} from "@/lib/website-integrations";

// Public widget endpoint — button only. text/html, CORS *, Supabase-only.
// Empty 200 when no addendum PDF exists for the VIN.

export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(
  request: NextRequest,
  { params }: { params: { vin: string; theme: string } },
) {
  const vin = params.vin;
  const theme = params.theme;
  const textOverride = request.nextUrl.searchParams.get("text");

  const pdfUrl = await checkPdfExists(vin.toUpperCase());
  if (!pdfUrl) return empty200();

  // Per-dealer customization (label/css/enabled) — best-effort; the button
  // still renders with defaults if the vehicle/integration lookups miss.
  // Optional ?dealer= resolves the integration directly (no vehicle lookup
  // needed for a button); unknown dealer value → empty like missing data.
  let buttonLabel = textOverride || "Download Addendum";
  let buttonCss = PLATFORM_BUTTON_CSS;
  const sb = publicSupabase();
  const dealerParam = request.nextUrl.searchParams.get("dealer");
  let integrationDealerId: string | null = null;
  if (dealerParam) {
    integrationDealerId = await resolveDealerParam(sb, dealerParam);
    if (!integrationDealerId) return empty200();
  } else {
    const vehicle = await resolveWidgetVehicle(sb, vin, null);
    if (vehicle) integrationDealerId = vehicle.dealer_id;
  }
  if (integrationDealerId) {
    const integration = await getIntegration(sb, integrationDealerId);
    if (integration && !integration.enabled) return empty200();
    // Account value wins over a caller-supplied ?text= override.
    if (integration?.button_label) buttonLabel = integration.button_label;
    // Sanitized — served cross-origin to dealer websites.
    if (integration?.button_css) buttonCss = sanitizeButtonCss(integration.button_css);
  }

  return html200(
    `<div class="${escapeHtml(theme)}"><style>${buttonCss}</style><a href="${pdfUrl}" class="dealer-addendums__button__download-button" target="_blank">${escapeHtml(buttonLabel)}</a></div>`,
  );
}
