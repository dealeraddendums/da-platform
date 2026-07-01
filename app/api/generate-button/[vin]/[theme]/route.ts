export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { checkPdfExists } from "@/lib/addendum";
import {
  PLATFORM_BUTTON_CSS,
  publicSupabase,
  resolveWidgetVehicle,
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
  let buttonLabel = textOverride || "Download Addendum";
  let buttonCss = PLATFORM_BUTTON_CSS;
  const sb = publicSupabase();
  const vehicle = await resolveWidgetVehicle(sb, vin, null);
  if (vehicle) {
    const integration = await getIntegration(sb, vehicle.dealer_id);
    if (integration && !integration.enabled) return empty200();
    if (!textOverride && integration?.button_label) buttonLabel = integration.button_label;
    if (integration?.button_css) buttonCss = integration.button_css;
  }

  return html200(
    `<div class="${escapeHtml(theme)}"><style>${buttonCss}</style><a href="${pdfUrl}" class="dealer-addendums__button__download-button" target="_blank">${escapeHtml(buttonLabel)}</a></div>`,
  );
}
