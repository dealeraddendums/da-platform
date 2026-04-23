import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import type { JwtClaims } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerSettingsUpdate } from "@/lib/db";

const DEFAULTS = {
  ai_content_default: false,
  nudge_left: 0,
  nudge_right: 0,
  nudge_top: 0,
  nudge_bottom: 0,
  default_template_new: null,
  default_template_used: null,
  default_template_cpo: null,
  default_addendum_new: null,
  default_addendum_used: null,
  default_addendum_cpo: null,
  default_infosheet_new: null,
  default_infosheet_used: null,
  default_infosheet_cpo: null,
  default_buyersguide_new: null,
  default_buyersguide_used: null,
  default_buyersguide_cpo: null,
};

async function resolveDealerId(
  req: NextRequest,
  claims: JwtClaims
): Promise<{ dealerId: string } | { dealerError: NextResponse }> {
  if (claims.role === "dealer_admin" || claims.role === "dealer_user") {
    if (!claims.dealer_id) {
      return { dealerError: NextResponse.json({ error: "No dealer assigned" }, { status: 403 }) };
    }
    return { dealerId: claims.dealer_id };
  }
  const paramId = req.nextUrl.searchParams.get("dealer_id");
  if (!paramId) {
    return { dealerError: NextResponse.json({ error: "dealer_id param required" }, { status: 400 }) };
  }
  if (claims.role === "group_admin") {
    const admin = createAdminSupabaseClient();
    const { data: dealer } = await admin.from("dealers").select("group_id").eq("dealer_id", paramId).single();
    if (!dealer || dealer.group_id !== claims.group_id) {
      return { dealerError: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    }
  }
  return { dealerId: paramId };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (claims.role === "dealer_user") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const resolved = await resolveDealerId(req, claims);
  if ("dealerError" in resolved) return resolved.dealerError;
  const { dealerId } = resolved;

  const admin = createAdminSupabaseClient();
  const { data } = await admin
    .from("dealer_settings")
    .select("*")
    .eq("dealer_id", dealerId)
    .single();

  return NextResponse.json({ data: data ?? { dealer_id: dealerId, ...DEFAULTS, updated_at: null } });
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (claims.role === "dealer_user") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const resolved = await resolveDealerId(req, claims);
  if ("dealerError" in resolved) return resolved.dealerError;
  const { dealerId } = resolved;

  let body: DealerSettingsUpdate;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const upsertPayload = {
    dealer_id: dealerId,
    ...(body.ai_content_default !== undefined && { ai_content_default: body.ai_content_default }),
    ...(body.nudge_left !== undefined && { nudge_left: body.nudge_left }),
    ...(body.nudge_right !== undefined && { nudge_right: body.nudge_right }),
    ...(body.nudge_top !== undefined && { nudge_top: body.nudge_top }),
    ...(body.nudge_bottom !== undefined && { nudge_bottom: body.nudge_bottom }),
    ...("default_template_new" in body && { default_template_new: body.default_template_new ?? null }),
    ...("default_template_used" in body && { default_template_used: body.default_template_used ?? null }),
    ...("default_template_cpo" in body && { default_template_cpo: body.default_template_cpo ?? null }),
    ...("default_addendum_new" in body && { default_addendum_new: body.default_addendum_new ?? null }),
    ...("default_addendum_used" in body && { default_addendum_used: body.default_addendum_used ?? null }),
    ...("default_addendum_cpo" in body && { default_addendum_cpo: body.default_addendum_cpo ?? null }),
    ...("default_infosheet_new" in body && { default_infosheet_new: body.default_infosheet_new ?? null }),
    ...("default_infosheet_used" in body && { default_infosheet_used: body.default_infosheet_used ?? null }),
    ...("default_infosheet_cpo" in body && { default_infosheet_cpo: body.default_infosheet_cpo ?? null }),
    ...("default_buyersguide_new" in body && { default_buyersguide_new: body.default_buyersguide_new ?? null }),
    ...("default_buyersguide_used" in body && { default_buyersguide_used: body.default_buyersguide_used ?? null }),
    ...("default_buyersguide_cpo" in body && { default_buyersguide_cpo: body.default_buyersguide_cpo ?? null }),
  };

  const admin = createAdminSupabaseClient();
  const { data, error: upsertErr } = await admin
    .from("dealer_settings")
    .upsert(upsertPayload, { onConflict: "dealer_id" })
    .select()
    .single();

  if (upsertErr) {
    return NextResponse.json({ error: upsertErr.message }, { status: 500 });
  }

  return NextResponse.json({ data });
}
