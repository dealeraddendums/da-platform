// Shared building blocks for the public Website Integrations widget endpoints
// (generate-addendum / generate-button). These routes are PUBLIC (embedded on
// 1,600+ dealer sites), return text/html with CORS *, and read Supabase only.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

export const PLATFORM_BUTTON_CSS = `
.dealer-addendums__button__download-button {
  display: inline-block;
  background-color: #1976d2;
  color: #ffffff;
  padding: 10px 20px;
  border-radius: 4px;
  text-decoration: none;
  font-family: sans-serif;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.dealer-addendums__button__download-button:hover { background-color: #1565c0; }
.dealer-addendums__pricing { margin-bottom: 12px; }
.dealer-addendums__pricing__list { list-style: none; margin: 0; padding: 0; }
.dealer-addendums__pricing__list li {
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
  font-family: sans-serif;
  font-size: 14px;
}
`;

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "public, max-age=60",
};

const HTML_HEADERS = { ...CORS_HEADERS, "Content-Type": "text/html; charset=utf-8" };

/** Empty 200 (text/html) — the widget checks truthiness before injecting. */
export function empty200(): NextResponse {
  return new NextResponse("", { status: 200, headers: HTML_HEADERS });
}

export function html200(body: string): NextResponse {
  return new NextResponse(body, { status: 200, headers: HTML_HEADERS });
}

export function corsPreflight(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

// Untyped service-role client — public endpoint, RLS not needed, and the new
// dealer_website_integrations table isn't in the generated Database types.
export function publicSupabase(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export interface WidgetVehicle {
  id: string;
  dealer_id: string;
  msrp: number | null;
  internet_price: string | null;
}

export interface WidgetIntegration {
  button_label: string | null;
  button_css: string | null;
  enabled: boolean;
}

export interface WidgetOption {
  option_name: string;
  description: string | null;
  option_price: string | number | null;
}

/** Resolve the active vehicle by VIN (+ optional stock), returning its id, dealer + pricing. */
export async function resolveWidgetVehicle(
  sb: SupabaseClient,
  vin: string,
  stock: string | null,
): Promise<WidgetVehicle | null> {
  let q = sb
    .from("dealer_vehicles")
    .select("id, dealer_id, msrp, internet_price, stock_number")
    .ilike("vin", vin)
    // 5.0 dealer_vehicles use status "active"/"inactive" (NOT legacy Aurora's "1").
    .eq("status", "active");
  if (stock) q = q.eq("stock_number", stock);
  const { data } = await q.limit(1).maybeSingle();
  if (!data) return null;
  return { id: data.id, dealer_id: data.dealer_id, msrp: data.msrp ?? null, internet_price: data.internet_price ?? null };
}

/**
 * The dealer's live addendum options for a vehicle — from vehicle_options, the
 * 5.0-native table the Builder + print engine use (NOT addendum_data, which is
 * legacy Aurora-sync/history). Ordered by the dealer's configured sort_order.
 */
export async function getVehicleOptions(sb: SupabaseClient, vehicleId: string): Promise<WidgetOption[]> {
  const { data } = await sb
    .from("vehicle_options")
    .select("option_name, description, option_price")
    .eq("vehicle_id", vehicleId)
    .order("sort_order", { ascending: true });
  return (data as WidgetOption[]) ?? [];
}

/** Fetch a dealer's widget integration config (label/css/enabled), or null.
 *  Two provider rows can exist: 'api' (Generate Button API card — direct
 *  embedders) and 'dealer_com'. The 'api' row wins when present; 'dealer_com'
 *  is the fallback so pre-existing Dealer.com customizations keep applying to
 *  the same public routes (DDC's canonical call is /generate-addendum/…). */
export async function getIntegration(sb: SupabaseClient, dealerId: string): Promise<WidgetIntegration | null> {
  const { data } = await sb
    .from("dealer_website_integrations")
    .select("provider, button_label, button_css, enabled")
    .eq("dealer_id", dealerId)
    .in("provider", ["api", "dealer_com"]);
  const rows = (data ?? []) as (WidgetIntegration & { provider: string })[];
  return rows.find((r) => r.provider === "api") ?? rows.find((r) => r.provider === "dealer_com") ?? null;
}

/** Sanitize dealer-supplied button CSS before injecting it into a <style>
 *  block served cross-origin to dealer websites. CSS has no legitimate use
 *  for '<', so all tag-opens are stripped (kills </style> breakouts and
 *  <script> injection), along with @import, IE expression(), javascript:
 *  URLs, and any url() that isn't plain https. */
export function sanitizeButtonCss(css: string | null | undefined): string {
  if (!css) return "";
  return String(css)
    .replace(/</g, "")
    .replace(/@import\b/gi, "")
    .replace(/expression\s*\(/gi, "")
    .replace(/javascript\s*:/gi, "")
    .replace(/url\s*\(([^)]*)\)/gi, (match, inner: string) => {
      const v = inner.trim().replace(/^['"]|['"]$/g, "");
      return /^https:\/\//i.test(v) ? match : "";
    });
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
