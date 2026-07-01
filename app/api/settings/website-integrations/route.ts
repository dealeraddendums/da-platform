import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveDealerForRequest } from "@/lib/dealer-authz";

// Dealer-facing config for the public Website Integrations widget
// (dealer_website_integrations, provider='dealer_com'). Mirrors /api/settings
// auth: dealer_admin / group_admin (acting as dealer) / super_admin; dealer_user
// is blocked. The table isn't in the generated Database types, so the client is
// cast to any for these queries (same pattern as starter_templates).

const PROVIDER = "dealer_com";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role === "dealer_user") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const resolved = await resolveDealerForRequest(claims, req.nextUrl.searchParams.get("dealer_id"));
  if (!resolved.ok) return resolved.response;
  const { dealerId } = resolved;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminSupabaseClient() as any;
  const { data } = await admin
    .from("dealer_website_integrations")
    .select("provider, button_label, button_css, enabled, updated_at")
    .eq("dealer_id", dealerId)
    .eq("provider", PROVIDER)
    .maybeSingle();

  // Defaults when the dealer hasn't configured it yet.
  return NextResponse.json({
    data: data ?? { provider: PROVIDER, button_label: "Download Addendum", button_css: null, enabled: true, updated_at: null },
  });
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role === "dealer_user") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const resolved = await resolveDealerForRequest(claims, req.nextUrl.searchParams.get("dealer_id"));
  if (!resolved.ok) return resolved.response;
  const { dealerId } = resolved;

  let body: { provider?: string; button_label?: string; button_css?: string | null; enabled?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const provider = (body.provider || PROVIDER).trim();
  if (provider !== PROVIDER) {
    return NextResponse.json({ error: `Unsupported provider "${provider}"` }, { status: 400 });
  }

  const upsertPayload: Record<string, unknown> = {
    dealer_id: dealerId,
    provider,
    updated_at: new Date().toISOString(),
    ...(body.button_label !== undefined && { button_label: (body.button_label || "").trim() || "Download Addendum" }),
    // Empty string → null so the widget falls back to platform default CSS.
    ...("button_css" in body && { button_css: body.button_css && body.button_css.trim() ? body.button_css : null }),
    ...(body.enabled !== undefined && { enabled: !!body.enabled }),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminSupabaseClient() as any;
  const { data, error: upErr } = await admin
    .from("dealer_website_integrations")
    .upsert(upsertPayload, { onConflict: "dealer_id,provider" })
    .select("provider, button_label, button_css, enabled, updated_at")
    .maybeSingle();

  if (upErr) {
    return NextResponse.json({ error: upErr.message }, { status: 500 });
  }
  return NextResponse.json({ data });
}
